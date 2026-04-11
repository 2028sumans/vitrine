/**
 * POST /api/refine
 *
 * Incremental refinement within a shopping session.
 * Called when the user taps "say more" or scrolls to the end of results.
 *
 * 1. If a comment is provided → Claude updates the aesthetic
 * 2. If liked product IDs are provided → fetch their Pinecone embeddings, use as new query centroid
 * 3. Re-query Pinecone → fetch from Algolia → filter → return new candidates
 */

import { NextResponse }                      from "next/server";
import { refineAesthetic }                   from "@/lib/ai";
import { filterByAvoids, filterMensItems }   from "@/lib/ai";
import { getProductsByIds, groupByCategory } from "@/lib/algolia";
import {
  searchByLikedProductIds,
  searchByEmbeddings,
  clusterEmbeddings,
  blendCentroids,
} from "@/lib/embeddings";
import type { StyleDNA } from "@/lib/types";

export async function POST(request: Request) {
  const {
    comment,
    likedProductIds,
    shownProductIds,
    currentAesthetic,
    userToken,
  }: {
    comment?:         string;
    likedProductIds?: string[];
    shownProductIds?: string[];
    currentAesthetic: StyleDNA;
    userToken?:       string;
  } = await request.json();

  if (!currentAesthetic) {
    return NextResponse.json({ error: "Missing currentAesthetic" }, { status: 400 });
  }

  try {
    // 1. Refine aesthetic if comment provided
    let aesthetic: StyleDNA = currentAesthetic;
    if (comment?.trim()) {
      aesthetic = await refineAesthetic(currentAesthetic, comment.trim());
    }

    // 2. Get new products — prefer liked-product embedding path (visual) over text fallback
    let objectIDs: string[] = [];
    const liked  = likedProductIds ?? [];
    const shown  = shownProductIds ?? [];

    if (liked.length > 0) {
      // Use liked product CLIP embeddings as the new query centroid
      objectIDs = await searchByLikedProductIds(liked, 80, aesthetic.price_range, shown);
    }

    // If no liked products or Pinecone returned nothing, fall back to Algolia text search
    if (objectIDs.length === 0) {
      const { fetchCandidateProductsByCategory } = await import("@/lib/ai");
      const rawCandidates = await fetchCandidateProductsByCategory(aesthetic, userToken ?? "anon");
      const afterAvoids   = filterByAvoids(rawCandidates, aesthetic.avoids ?? []);
      const candidates    = filterMensItems(afterAvoids);
      return NextResponse.json({ aesthetic, candidates });
    }

    // 3. Hydrate from Algolia
    const products   = await getProductsByIds(objectIDs);
    const grouped    = groupByCategory(products, 15);
    const afterAvoids = filterByAvoids(grouped, aesthetic.avoids ?? []);
    const candidates  = filterMensItems(afterAvoids);

    return NextResponse.json({ aesthetic, candidates });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[refine] Failed:", message);
    return NextResponse.json({ error: "Refine failed", detail: message }, { status: 500 });
  }
}
