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
const CLOTHING_THRESHOLD   = 0.22; // tightened from 0.18 — drops more noise

// Prompts used to build the "outfit-ness" positive reference.
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

// Negative reference — if a pin scores higher against these than against the
// clothing prompts, it's filtered out. Catches portraits, interiors, food,
// makeup and landscape shots that slip through the Pinterest metadata filter.
const NON_CLOTHING_PROMPTS = [
  "a portrait of a face",
  "an interior photograph of a room",
  "food photography",
  "a landscape photo",
  "a bowl of food",
  "a flower arrangement",
  "makeup on a face",
  "nail art",
  "a hairstyle",
  "home decor",
];

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const pinImageUrls: string[] = Array.isArray(body?.pinImageUrls) ? body.pinImageUrls : [];
  const brandFilter: string    = typeof body?.brandFilter === "string" ? body.brandFilter.trim() : "";

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

    // 2. Dual-prompt filter: positive (clothing) vs negative (portrait,
    //    interior, food, makeup, landscape). Keep a pin only if its positive
    //    score clears the threshold AND beats its negative score. Catches
    //    pins whose metadata slipped past the keyword pre-filter.
    const [positiveVecs, negativeVecs] = await Promise.all([
      Promise.all(CLOTHING_PROMPTS.map((p) => embedTextQuery(p).catch(() => [] as number[]))),
      Promise.all(NON_CLOTHING_PROMPTS.map((p) => embedTextQuery(p).catch(() => [] as number[]))),
    ]);
    const validPositives = positiveVecs.filter((v) => v.length > 0);
    const validNegatives = negativeVecs.filter((v) => v.length > 0);

    let clothingEmbeds = valid;
    if (validPositives.length > 0) {
      const maxSim = (imgVec: number[], refs: number[][]) =>
        refs.length === 0 ? -Infinity : Math.max(...refs.map((r) => cosineSimilarity(imgVec, r)));
      const scored = valid.map((v) => ({
        vec:     v,
        pos:     maxSim(v, validPositives),
        neg:     maxSim(v, validNegatives),
      }));
      const kept = scored.filter((x) => x.pos >= CLOTHING_THRESHOLD && x.pos > x.neg);
      console.log(
        `[shop-personalized] dual-filter: kept ${kept.length}/${valid.length} pins ` +
        `(threshold ${CLOTHING_THRESHOLD}; scores pos/neg: ` +
        `${scored.map((s) => `${s.pos.toFixed(2)}/${s.neg.toFixed(2)}`).join(", ")})`
      );
      // If nothing survives, fall back to all pins rather than no signal.
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

    let clean = ordered.filter((p) => typeof p.image_url === "string" && p.image_url.startsWith("http"));

    // Brand-mode scope: keep only products from the current brand so the
    // pool can still bias /shop toward Pinterest taste within the brand.
    if (brandFilter) {
      const want = brandFilter.toLowerCase();
      clean = clean.filter((p) => {
        const b = String((p as { brand?: unknown }).brand ?? "").toLowerCase();
        const r = String((p as { retailer?: unknown }).retailer ?? "").toLowerCase();
        return b === want || r === want;
      });
    }

    return NextResponse.json({
      products:        clean,
      pinsUsed:        clothingEmbeds.length,
      pinsTotal:       valid.length,
      clothingFiltered: validPositives.length > 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shop-personalized] failed:", message);
    return NextResponse.json({ products: [], error: message });
  }
}
