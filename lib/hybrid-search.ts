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
import { searchByEmbeddings, searchByVibeText, searchByTasteEmbeddings } from "@/lib/embeddings";
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
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, maxResults);
}

/** Build the Claude-native vibe phrases we'll encode against the `vibe` namespace. */
function vibePhrases(dna: StyleDNA): string[] {
  const out: string[] = [];
  // Full-sentence retrieval phrases are already written in FashionCLIP-native
  // vocabulary, so they're ideal anchors against captioned product vectors.
  for (const p of dna.retrieval_phrases ?? []) {
    if (typeof p === "string" && p.trim()) out.push(p.trim());
  }
  if (out.length > 0) return out.slice(0, 8);

  // Fallback: synthesise a short vibe line from the structured fields.
  const synthesised = [
    dna.primary_aesthetic, dna.secondary_aesthetic, dna.mood,
    ...(dna.color_palette ?? []).slice(0, 3),
    ...(dna.silhouettes   ?? []).slice(0, 2),
    ...(dna.style_keywords ?? []).slice(0, 4),
  ].filter((s): s is string => Boolean(s?.trim())).join(", ");
  return synthesised ? [synthesised] : [];
}

/**
 * Run Pinecone visual search + Algolia text search + Pinecone vibe-vector
 * search in parallel, merge results per category with RRF.
 *
 * Three rankers vote by default:
 *   - visual  : FashionCLIP image-text vector similarity (default namespace)
 *   - vibe    : Claude-caption vector similarity         (`vibe` namespace)
 *   - algolia : category-aware keyword search
 *
 * When `useTasteHead` is true, a fourth ranker joins:
 *   - taste   : learned projection of FashionCLIP vectors trained on the
 *               curation log (`taste` namespace). Off by default because the
 *               W is currently trained on limited data and its generalization
 *               hasn't been A/B'd — activate by passing ?taste=1 via the route
 *               layer (see app/api/shop/route.ts) so it's easy to feel-test
 *               without risking the main feed.
 *
 * Falls back to whatever subset is non-empty.
 */
export async function hybridSearch(
  embeddings:     number[][],
  aesthetic:      StyleDNA,
  userToken:      string,
  maxPerCategory  = 20,
  opts:           { useTasteHead?: boolean } = {},
): Promise<CategoryCandidates> {
  const useTasteHead = opts.useTasteHead === true;
  const valid   = embeddings.filter((e) => e.length > 0);
  const phrases = vibePhrases(aesthetic);

  const [pineconeIds, vibeIds, tasteIds, algoliaCandidates] = await Promise.all([
    valid.length > 0
      ? searchByEmbeddings(valid, 200, { priceRange: aesthetic.price_range }).catch(() => [] as string[])
      : Promise.resolve([] as string[]),

    phrases.length > 0
      ? searchByVibeText(phrases, 200, { priceRange: aesthetic.price_range }).catch(() => [] as string[])
      : Promise.resolve([] as string[]),

    // Taste head: learned projection on top of FashionCLIP. Only fires when
    // the caller explicitly opts in via useTasteHead — this keeps the main
    // feed on three well-understood rankers while we A/B the trained W.
    // (Also drops out silently when no head is trained or no vectors in the
    // `taste` namespace.)
    useTasteHead && valid.length > 0
      ? searchByTasteEmbeddings(valid, 200, { priceRange: aesthetic.price_range }).catch(() => [] as string[])
      : Promise.resolve([] as string[]),

    searchByCategory(
      aesthetic.category_queries,
      aesthetic.style_keywords ?? [],
      aesthetic.price_range ?? "mid",
      maxPerCategory * 2,
      userToken,
    ).catch(() => emptyBuckets()),
  ]);

  const allPineconeIds = Array.from(new Set([...pineconeIds, ...vibeIds, ...tasteIds]));
  if (allPineconeIds.length === 0) {
    console.log("[hybrid] Pinecone empty (visual + vibe + taste) — using Algolia only");
    return algoliaCandidates;
  }

  // Hydrate the union of IDs returned by any Pinecone namespace once.
  const pineconeProducts = await getProductsByIds(allPineconeIds);
  const visualBuckets    = groupByCategory(
    pineconeProducts.filter((p) => pineconeIds.includes(p.objectID)),
    maxPerCategory * 2,
  );
  const vibeBuckets      = groupByCategory(
    pineconeProducts.filter((p) => vibeIds.includes(p.objectID)),
    maxPerCategory * 2,
  );
  const tasteBuckets     = groupByCategory(
    pineconeProducts.filter((p) => tasteIds.includes(p.objectID)),
    maxPerCategory * 2,
  );

  const tasteLabel = useTasteHead ? String(tasteIds.length) : "off";
  console.log(
    `[hybrid] visual=${pineconeIds.length} vibe=${vibeIds.length} taste=${tasteLabel} ` +
    `algolia=${Object.values(algoliaCandidates).flat().length}`
  );

  const merged = emptyBuckets();

  for (const cat of CATEGORIES) {
    const visIds  = visualBuckets[cat].map((p) => p.objectID);
    const vibIds  = vibeBuckets[cat].map((p) => p.objectID);
    const tstIds  = tasteBuckets[cat].map((p) => p.objectID);
    const algIds  = algoliaCandidates[cat].map((p) => p.objectID);

    const mergedIds = rrfMerge([visIds, vibIds, tstIds, algIds], maxPerCategory);

    const lookup = new Map<string, AlgoliaProduct>();
    [...visualBuckets[cat], ...vibeBuckets[cat], ...tasteBuckets[cat], ...algoliaCandidates[cat]].forEach((p) => {
      if (!lookup.has(p.objectID)) lookup.set(p.objectID, p);
    });

    merged[cat] = mergedIds
      .map((id) => lookup.get(id))
      .filter((p): p is AlgoliaProduct => p != null);
  }

  return merged;
}
