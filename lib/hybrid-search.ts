/**
 * Hybrid Algolia + Pinecone search with Reciprocal Rank Fusion (RRF).
 *
 * Runs both engines in parallel, merges their per-category ranked lists
 * using RRF (k=60), and returns a unified CategoryCandidates result.
 *
 * Why RRF?
 *   - Algolia excels at keyword precision, brand/color matching, price filters
 *   - Pinecone excels at visual similarity and semantic style queries
 *   - RRF merges two ranked lists without needing to tune a weight: each item
 *     gets 1/(rank + 60) points per list; higher total = better combined match
 */

import type { AlgoliaProduct, CategoryCandidates, ClothingCategory } from "@/lib/algolia";
import { getProductsByIds, groupByCategory, searchByCategory } from "@/lib/algolia";
import { searchByEmbeddings } from "@/lib/embeddings";
import type { StyleDNA } from "@/lib/types";

const CATEGORIES: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];
const RRF_K = 60; // standard constant — dampens the impact of very high ranks

function emptyBuckets(): CategoryCandidates {
  return { dress: [], top: [], bottom: [], jacket: [], shoes: [], bag: [] };
}

/** Merge N ranked ID lists with RRF, return top maxResults IDs. */
function rrfMerge(lists: string[][], maxResults: number): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (rank + RRF_K));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, maxResults);
}

/**
 * Run Pinecone visual search + Algolia text search in parallel,
 * merge results per category with RRF.
 *
 * Falls back to pure Algolia if Pinecone returns nothing.
 */
export async function hybridSearch(
  embeddings:     number[][],
  aesthetic:      StyleDNA,
  userToken:      string,
  maxPerCategory  = 20,
): Promise<CategoryCandidates> {
  const valid = embeddings.filter((e) => e.length > 0);

  const [pineconeIds, algoliaCandidates] = await Promise.all([
    // Pinecone: visual similarity search (fetch generous 200 to have enough per category)
    valid.length > 0
      ? searchByEmbeddings(valid, 200, aesthetic.price_range).catch(() => [] as string[])
      : Promise.resolve([] as string[]),

    // Algolia: category-aware text search using Claude-generated aesthetic queries
    searchByCategory(
      aesthetic.category_queries,
      aesthetic.style_keywords ?? [],
      aesthetic.price_range ?? "mid",
      maxPerCategory * 2,
      userToken,
    ).catch(() => emptyBuckets()),
  ]);

  // If Pinecone returned nothing, pure Algolia result is the best we can do
  if (pineconeIds.length === 0) {
    console.log("[hybrid] Pinecone empty — using Algolia only");
    return algoliaCandidates;
  }

  // Hydrate Pinecone IDs → full product objects
  const pineconeProducts = await getProductsByIds(pineconeIds);
  const pineconeBuckets  = groupByCategory(pineconeProducts, maxPerCategory * 2);

  console.log(
    `[hybrid] Pinecone: ${pineconeIds.length} ids → ${pineconeProducts.length} products | ` +
    `Algolia: ${Object.values(algoliaCandidates).flat().length} products`
  );

  // RRF per category bucket
  const merged = emptyBuckets();

  for (const cat of CATEGORIES) {
    const pinIds = pineconeBuckets[cat].map((p) => p.objectID);
    const algIds = algoliaCandidates[cat].map((p) => p.objectID);

    const mergedIds = rrfMerge([pinIds, algIds], maxPerCategory);

    // Build lookup — Algolia data preferred (fresher, has queryID for Insights)
    const lookup = new Map<string, AlgoliaProduct>();
    [...pineconeBuckets[cat], ...algoliaCandidates[cat]].forEach((p) => {
      if (!lookup.has(p.objectID)) lookup.set(p.objectID, p);
    });

    merged[cat] = mergedIds
      .map((id) => lookup.get(id))
      .filter((p): p is AlgoliaProduct => p != null);
  }

  return merged;
}
