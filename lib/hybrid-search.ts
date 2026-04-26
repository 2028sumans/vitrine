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
import {
  searchByEmbeddings,
  searchByVibeText,
  searchByTasteEmbeddings,
  embedTextQuery,
  fetchVisualAndVibeVectors,
  cosineSimilarity,
} from "@/lib/embeddings";
import type { StyleDNA } from "@/lib/types";

const CATEGORIES: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];
const RRF_K = 60; // standard constant — dampens the impact of very high ranks

function emptyBuckets(): CategoryCandidates {
  return { dress: [], top: [], bottom: [], jacket: [], shoes: [], bag: [] };
}

/**
 * Merge N ranked ID lists with RRF. Optional per-list weights let strict-mode
 * callers de-emphasise noisy rankers (e.g. Algolia keyword match) without
 * removing them entirely — weight=0.25 means the voter still contributes
 * diversity but can't single-handedly push an off-aesthetic hit into the
 * top results. Default weight per list = 1 (original behaviour).
 */
function rrfMerge(lists: string[][], maxResults: number, weights?: number[]): string[] {
  const scores = new Map<string, number>();
  for (let i = 0; i < lists.length; i++) {
    const w = weights?.[i] ?? 1;
    if (w === 0) continue;
    lists[i].forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + w / (rank + RRF_K));
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

  // Fallback: build a NATURAL SENTENCE from structured fields. The previous
  // version comma-joined everything into "minimalist, with parisian undertones,
  // unhurried, cream, navy, oversized, …" — keyword salad pushes the encoded
  // vector into low-density CLIP space and the search recovers generic
  // products. A real sentence stays in the captioned-image neighborhood and
  // recovers on-aesthetic products.
  const aesthetic = (dna.primary_aesthetic ?? "").trim();
  const colors    = (dna.color_palette ?? []).slice(0, 3).filter(Boolean);
  const sils      = (dna.silhouettes  ?? []).slice(0, 2).filter(Boolean);
  if (!aesthetic && colors.length === 0 && sils.length === 0) return [];

  const lead   = aesthetic ? `a ${aesthetic} outfit` : "an outfit";
  const palette = colors.length > 0
    ? ` in ${colors.length === 1 ? colors[0] : colors.slice(0, -1).join(", ") + " and " + colors[colors.length - 1]}`
    : "";
  const shapes = sils.length > 0
    ? ` with ${sils.join(" and ")}`
    : "";
  return [`a photo of ${lead}${palette}${shapes}`];
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
/** Strictness knobs for semantic queries — default loose, set strict via opts. */
const STRICT_MIN_SCORE      = 0.20;  // cosine floor for Pinecone visual/vibe
const STRICT_ALGOLIA_WEIGHT = 0.25;  // RRF weight multiplier for Algolia voter

// Loose-mode (Pinterest/uploads) RRF weights:
//   visual = 3, vibe = 1, taste = 0|1, algolia = 0.5
// → visual ≈ 67%, vibe ≈ 22%, algolia ≈ 11% (with taste off).
// The user-facing query in loose mode IS an image, so image-to-image cosine
// is the most direct signal. Keyword keyword match on title text is the
// weakest because it's downstream of Claude's keyword inference from the
// same images. Vibe lands in between (image-to-caption is CLIP's secondary
// training objective).
const LOOSE_VISUAL_WEIGHT  = 3;
const LOOSE_VIBE_WEIGHT    = 1;
const LOOSE_ALGOLIA_WEIGHT = 0.5;

// 2-stage strict-mode rerank weights — visual (image vectors) gets 4× the
// pull of vibe (caption vectors) because text→image is FashionCLIP's primary
// training objective; text→caption (text-to-text in CLIP space) is suboptimal
// for the model.
const STAGE2_VISUAL_WEIGHT = 0.8;
const STAGE2_VIBE_WEIGHT   = 0.2;

// Below this many Algolia hits we drop to FashionCLIP-only search instead
// of doing 2-stage rerank — the literal gate didn't catch enough to be
// useful, the user's brief was too abstract for keyword matching.
const STAGE2_MIN_POOL = 30;

export async function hybridSearch(
  embeddings:     number[][],
  aesthetic:      StyleDNA,
  userToken:      string,
  maxPerCategory  = 20,
  opts:           { useTasteHead?: boolean; strict?: boolean } = {},
): Promise<CategoryCandidates> {
  const useTasteHead = opts.useTasteHead === true;
  // Strict mode = typed text / quiz queries where the user gave a deliberate
  // brief. Raises the Pinecone similarity floor and de-weights the Algolia
  // keyword voter so off-aesthetic neighbours (bikini bags in a dad-chic
  // brief, pink slip dresses in an old-money brief, etc.) don't survive
  // the RRF merge just because they happened to be among the top-K or
  // keyword-matched a color word.
  //
  // Pinterest / upload modes default to loose — the user didn't give us
  // words, so we need the wider net.
  const strict = opts.strict === true;
  const minScore = strict ? STRICT_MIN_SCORE : 0;
  const algoliaWeight = strict ? STRICT_ALGOLIA_WEIGHT : 1;

  const valid   = embeddings.filter((e) => e.length > 0);
  const phrases = vibePhrases(aesthetic);

  // Pinecone topK feeds the per-category RRF merge below. 200 was sized
  // for maxPerCategory=20; with maxPerCategory now defaulting to 50 the
  // merge needs ~6×50×2 = 600 candidate IDs to draw from, so each lane
  // pulls 500. The bigger fetch is bandwidth-cheap (just IDs) and the
  // RRF merge is O(N) anyway.
  const PINECONE_TOPK = Math.max(200, maxPerCategory * 10);
  const [pineconeIds, vibeIds, tasteIds, algoliaCandidates] = await Promise.all([
    valid.length > 0
      ? searchByEmbeddings(valid, PINECONE_TOPK, { priceRange: aesthetic.price_range, minScore }).catch(() => [] as string[])
      : Promise.resolve([] as string[]),

    phrases.length > 0
      ? searchByVibeText(phrases, PINECONE_TOPK, { priceRange: aesthetic.price_range, minScore }).catch(() => [] as string[])
      : Promise.resolve([] as string[]),

    // Taste head: learned projection on top of FashionCLIP. Only fires when
    // the caller explicitly opts in via useTasteHead — this keeps the main
    // feed on three well-understood rankers while we A/B the trained W.
    // (Also drops out silently when no head is trained or no vectors in the
    // `taste` namespace.)
    useTasteHead && valid.length > 0
      ? searchByTasteEmbeddings(valid, PINECONE_TOPK, { priceRange: aesthetic.price_range, minScore }).catch(() => [] as string[])
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

    // RRF weights:
    //   strict mode (text/quiz, but typically routed through twoStageStrict-
    //   Search now — kept here as the fallback path) deweights Algolia to
    //   0.25 so noisy keyword hits can't push off-aesthetic items in.
    //   loose mode (Pinterest/uploads) bumps the visual ranker to 3× because
    //   the query IS an image — direct image-to-image cosine is the most
    //   reliable signal we have, and Algolia is the noisiest because it's
    //   downstream of Claude's keyword inference from the same images.
    const visW = strict ? 1 : LOOSE_VISUAL_WEIGHT;
    const vibW = strict ? 1 : LOOSE_VIBE_WEIGHT;
    const algW = strict ? algoliaWeight : LOOSE_ALGOLIA_WEIGHT;
    const mergedIds = rrfMerge(
      [visIds, vibIds, tstIds, algIds],
      maxPerCategory,
      [visW, vibW, 1, algW],
    );

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

// ── 2-stage strict-mode search ────────────────────────────────────────────────
// Used for text and quiz queries (deliberate user briefs). Cleanly separates
// hard literal constraints (brand, color, garment, category) from soft semantic
// constraints (vibe, mood, era, season).
//
//   Stage 1 — Algolia gates:
//     run searchByCategory with Claude's category_queries + style_keywords as
//     boost. This narrows the catalog to items whose titles/brands/categories
//     literal-match the brief. For "blue khaite dress for summer" this is
//     ~30-100 blue Khaite dresses; for "y2k party" it's items keyword-matching
//     "low rise jeans", "metallic top" etc.
//
//   Stage 2 — FashionCLIP reranks within Algolia's pool:
//     fetch (visual, vibe) vector pair for every Algolia candidate from
//     Pinecone. Encode aesthetic.aesthetic_descriptor — Claude's purified
//     soft phrase ("summery breezy" / "y2k clubby") that intentionally
//     omits anything Algolia already filtered on. Score each candidate
//     with weighted cosine: 0.8 × cos(qVec, pVisual) + 0.2 × cos(qVec, pVibe).
//     Sort, return top-K per category.
//
// Fallback: if Algolia returns < STAGE2_MIN_POOL items combined, the literal
// gate misfired (brief was too abstract) — drop to the original parallel-RRF
// hybridSearch on the full catalog.
//
// Why this beats parallel RRF for typed queries: pre-2-stage, an Algolia hit
// with weight 0.25 could still vote a swimsuit-tagged-as-dress into the
// "summery dress" results because FashionCLIP also liked it. Stage 1 is now
// the only path into the candidate pool — if Algolia doesn't include it,
// it can't surface.
export async function twoStageStrictSearch(
  aesthetic:      StyleDNA,
  userToken:      string,
  maxPerCategory  = 50,
  opts:           { fallbackEmbeddings?: number[][]; useTasteHead?: boolean } = {},
): Promise<CategoryCandidates> {
  // Stage 1: Algolia gate. searchByCategory now returns the FULL pool per
  // category (capped only by pagination, not a hard slice), so this is a
  // wide net — anywhere from a few items to several thousand.
  const algoliaCandidates = await searchByCategory(
    aesthetic.category_queries,
    aesthetic.style_keywords ?? [],
    aesthetic.price_range ?? "mid",
    // Per-page request size; not a final cap. Pagination inside searchProducts
    // will pull more pages if Algolia has them.
    maxPerCategory * 4,
    userToken,
  ).catch((err) => {
    console.warn("[twoStage] Algolia gate failed:", err instanceof Error ? err.message : err);
    return emptyBuckets();
  });

  const totalAlgolia = Object.values(algoliaCandidates).flat().length;

  // Fallback: pool too small → drop to the loose parallel-RRF hybrid (which
  // doesn't depend on the literal gate). Brief was too abstract for Algolia.
  if (totalAlgolia < STAGE2_MIN_POOL) {
    console.log(`[twoStage] Algolia pool=${totalAlgolia} < ${STAGE2_MIN_POOL} — falling back to hybridSearch`);
    return hybridSearch(
      opts.fallbackEmbeddings ?? [],
      aesthetic,
      userToken,
      maxPerCategory,
      { useTasteHead: opts.useTasteHead, strict: true },
    );
  }

  // Encode the soft/aesthetic descriptor — the differentiator. NO brand,
  // NO color, NO garment, NO fabric (all of which Algolia already gated on).
  const descriptor = (aesthetic.aesthetic_descriptor ?? "").trim()
    || `${aesthetic.primary_aesthetic ?? ""} ${aesthetic.mood ?? ""}`.trim()
    || aesthetic.summary?.trim()
    || "stylish";

  const queryVec = await embedTextQuery(descriptor).catch(() => [] as number[]);
  if (queryVec.length === 0) {
    console.warn(`[twoStage] embedTextQuery("${descriptor.slice(0, 60)}") returned empty — using Algolia order only`);
    // Degrade to Algolia's own relevance order, no rerank.
    const out = emptyBuckets();
    for (const cat of CATEGORIES) {
      out[cat] = algoliaCandidates[cat].slice(0, maxPerCategory);
    }
    return out;
  }

  // Fetch (visual, vibe) vector pair for every Algolia candidate. Pinecone
  // 1000-id chunking is handled inside fetchVisualAndVibeVectors.
  const allIds  = Object.values(algoliaCandidates).flat().map((p) => p.objectID);
  const vectors = await fetchVisualAndVibeVectors(allIds);
  const vecById = new Map(vectors.map((v) => [v.id, v]));

  console.log(
    `[twoStage] descriptor="${descriptor.slice(0, 60)}" pool=${totalAlgolia} ` +
    `with-visual=${vectors.filter((v) => v.visual).length} with-vibe=${vectors.filter((v) => v.vibe).length}`
  );

  // Stage 2: rerank each per-category bucket by weighted cosine.
  const merged = emptyBuckets();
  for (const cat of CATEGORIES) {
    const candidates = algoliaCandidates[cat];
    if (candidates.length === 0) continue;

    const scored = candidates.map((product) => {
      const v = vecById.get(product.objectID);
      const visScore  = v?.visual ? cosineSimilarity(queryVec, v.visual) : 0;
      const vibeScore = v?.vibe   ? cosineSimilarity(queryVec, v.vibe)   : 0;
      // Items missing a visual vector still get a vibe-only score (×0.2)
      // and items missing both fall through with score 0 — they sort to
      // the bottom but stay in the result so the user isn't left short.
      const score = STAGE2_VISUAL_WEIGHT * visScore + STAGE2_VIBE_WEIGHT * vibeScore;
      return { product, score };
    });

    scored.sort((a, b) => b.score - a.score);
    merged[cat] = scored.slice(0, maxPerCategory).map((s) => s.product);
  }

  return merged;
}
