/**
 * POST /api/refine
 *
 * Single-call session refinement triggered by a user comment.
 *
 * 1. Claude (vision) refines the StyleDNA aggressively, picks which upcoming
 *    products still fit the new direction, and returns an intent summary.
 *    All in one shot — see lib/ai.ts:refineSessionWithComment.
 * 2. The REFINED aesthetic drives a fresh hybrid FashionCLIP + Algolia search
 *    so the new candidates actually reflect the comment (the old refine route
 *    used liked-product embeddings here, which ignored the comment entirely).
 * 3. Returns the refined DNA, the new candidates, the keep-list of upcoming
 *    objectIDs, and the intent string. The client wipes its upcoming queue,
 *    keeps the kept items, and inserts curated new cards.
 */

import { NextResponse }                              from "next/server";
import {
  fetchCandidateProductsByCategory,
  filterByAvoids,
  filterMensItems,
  refineSessionWithComment,
}                                                    from "@/lib/ai";
import { hybridSearch }                              from "@/lib/hybrid-search";
import { buildTextQueryVectors }                     from "@/lib/query-builder";
import { getProductsByIds }                          from "@/lib/algolia";
import { loadTasteMemory }                           from "@/lib/taste-memory";
import type { StyleDNA }                             from "@/lib/types";

const USE_VISUAL_SEARCH = !!(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX);

export async function POST(request: Request) {
  const {
    comment,
    upcomingProductIds = [],
    currentAesthetic,
    userToken,
  }: {
    comment?:             string;
    upcomingProductIds?:  string[]; // products in the user's upcoming queue (for prune)
    currentAesthetic:     StyleDNA;
    userToken?:           string;
  } = await request.json();

  if (!currentAesthetic) {
    return NextResponse.json({ error: "Missing currentAesthetic" }, { status: 400 });
  }

  const token = userToken || "anon";

  try {
    // 1. Hydrate upcoming products so Claude can see them
    const upcomingProducts = upcomingProductIds.length > 0
      ? await getProductsByIds(upcomingProductIds.slice(0, 16))
      : [];

    // 2. Single Claude vision call: refine + prune + interpret
    let refinedDNA: StyleDNA = currentAesthetic;
    let intent  = "";
    let keepIds: string[] = [];

    if (comment?.trim()) {
      const result = await refineSessionWithComment(
        currentAesthetic,
        comment.trim(),
        upcomingProducts.map((p) => ({
          objectID:  p.objectID,
          title:     p.title,
          brand:     p.brand,
          image_url: p.image_url,
        })),
      );
      refinedDNA = result.refinedDNA;
      intent     = result.intent;
      keepIds    = result.keepIds;
    } else {
      // No comment → keep everything upcoming, only refresh candidates
      keepIds = upcomingProductIds;
    }

    // 3. Fetch fresh candidates using the REFINED aesthetic
    //    (this is the bit the old route was missing — comment now actually
    //     drives the search, not just the JSON)
    const tasteMemory = await loadTasteMemory(token).catch(() => ({ softAvoids: [] as string[] }));

    let rawCandidates;
    if (USE_VISUAL_SEARCH) {
      const queryVectors = await buildTextQueryVectors(refinedDNA, tasteMemory.softAvoids);
      console.log(`[refine] hybrid search with ${queryVectors.length} refined query vectors`);
      rawCandidates = await hybridSearch(queryVectors, refinedDNA, token);
    } else {
      rawCandidates = await fetchCandidateProductsByCategory(refinedDNA, token);
    }

    // 4. Filter
    const allAvoids = [...(refinedDNA.avoids ?? []), ...(tasteMemory.softAvoids ?? [])];
    const filtered  = filterMensItems(filterByAvoids(rawCandidates, allAvoids));

    return NextResponse.json({
      aesthetic:  refinedDNA,
      candidates: filtered,
      keepIds,
      intent,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[refine] Failed:", message);
    return NextResponse.json({ error: "Refine failed", detail: message }, { status: 500 });
  }
}
