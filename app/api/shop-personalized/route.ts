/**
 * POST /api/shop-personalized
 *
 * Takes a list of Pinterest pin image URLs, filters to just the ones that
 * actually depict clothing, embeds them with FashionCLIP, queries Pinecone
 * for visually-similar catalog products, and returns them as a ranked pool.
 *
 * The /shop page uses this pool to bias the flat catalog feed at 30% weight
 * (interleaved 7 flat : 3 personalized per row of 10). It does NOT replace
 * the feed.
 *
 * Clothing-only filter:
 *   Fashion Pinterest boards still contain non-clothing pins — mood shots,
 *   portraits, interiors, beauty stills. We score each pin's image embedding
 *   against a mean of several clothing text prompts (dress, top, jacket,
 *   shoes, bag, etc.) in FashionCLIP's shared image-text space. Pins below
 *   a cosine-similarity threshold get dropped before Pinecone search.
 */

import { NextResponse }                                 from "next/server";
import {
  embedImageUrls,
  embedTextQuery,
  searchByEmbeddings,
  cosineSimilarity,
}                                                       from "@/lib/embeddings";
import { getProductsByIds }                             from "@/lib/algolia";

const MAX_PINS_TO_EMBED    = 24;
const TOP_K                = 150;
const CLOTHING_THRESHOLD   = 0.18; // cosine similarity lower bound against clothing prompts

// Prompts used to build the "outfit-ness" reference centroid.
const CLOTHING_PROMPTS = [
  "a photo of clothing",
  "a dress",
  "a top",
  "pants",
  "a skirt",
  "a jacket",
  "a coat",
  "shoes",
  "a handbag",
];

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const pinImageUrls: string[] = Array.isArray(body?.pinImageUrls) ? body.pinImageUrls : [];

  if (pinImageUrls.length === 0) {
    return NextResponse.json({ products: [] });
  }

  const urls = pinImageUrls.slice(0, MAX_PINS_TO_EMBED);

  try {
    // 1. Embed all pin images
    const embeddings = await embedImageUrls(urls);
    const valid = embeddings.filter((e) => e.length > 0);
    if (valid.length === 0) {
      console.log("[shop-personalized] no valid image embeddings — likely FashionCLIP/CDN failure");
      return NextResponse.json({ products: [] });
    }

    // 2. Build clothing reference centroid from text prompts, run the filter.
    //    If the text encoder fails entirely, fall through and use every pin.
    const promptVecs = await Promise.all(
      CLOTHING_PROMPTS.map((p) => embedTextQuery(p).catch(() => [] as number[])),
    );
    const validPromptVecs = promptVecs.filter((v) => v.length > 0);

    let clothingEmbeds = valid;
    if (validPromptVecs.length > 0) {
      const score = (imgVec: number[]) =>
        Math.max(...validPromptVecs.map((pVec) => cosineSimilarity(imgVec, pVec)));
      const scored = valid.map((v) => ({ vec: v, s: score(v) }));
      const kept = scored.filter((x) => x.s >= CLOTHING_THRESHOLD);
      console.log(
        `[shop-personalized] clothing-filter: kept ${kept.length}/${valid.length} pins ` +
        `(threshold ${CLOTHING_THRESHOLD}, scores: ${scored.map((s) => s.s.toFixed(2)).join(", ")})`
      );
      // If the filter dropped literally everything, fall back to all pins —
      // better a noisy signal than no signal at all.
      clothingEmbeds = kept.length > 0 ? kept.map((x) => x.vec) : valid;
    }

    // 3. Pinecone similarity search over the clothing-only embeddings
    const productIds = await searchByEmbeddings(clothingEmbeds, TOP_K);
    if (productIds.length === 0) {
      return NextResponse.json({ products: [] });
    }

    // 4. Hydrate & preserve the ranked order
    const raw  = await getProductsByIds(productIds);
    const byId = new Map(raw.map((p) => [p.objectID, p]));
    const ordered = productIds
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => p != null);

    const clean = ordered.filter((p) => typeof p.image_url === "string" && p.image_url.startsWith("http"));

    return NextResponse.json({
      products:        clean,
      pinsUsed:        clothingEmbeds.length,
      pinsTotal:       valid.length,
      clothingFiltered: validPromptVecs.length > 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shop-personalized] failed:", message);
    return NextResponse.json({ products: [], error: message });
  }
}
