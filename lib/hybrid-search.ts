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
import { buildTextQueryVectors } from "@/lib/query-builder";
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

// ── 2-stage strict-mode search (optimized) ────────────────────────────────────
// Used for text and quiz queries. Cleanly separates hard literal constraints
// (brand, color, garment, category) from soft semantic constraints (vibe, mood,
// era, season). Five interlocking improvements over the basic version:
//
//   1. Augmented gate (Algolia ∪ FashionCLIP semantic). Algolia title-matching
//      misses items with abstract titles (e.g. "Crew Tee Wash 12" that's
//      perfectly y2k visually). We run a parallel FashionCLIP semantic search
//      with retrieval_phrases and union the pools — Algolia anchors literal
//      precision, FashionCLIP catches the abstractly-titled items. No longer
//      need a < 30 fallback threshold.
//
//   2. Smart descriptor encoding. Multi-tier fallback when aesthetic_descriptor
//      is empty: descriptor → primary_aesthetic+mood → average of retrieval_
//      phrases → summary. Robust to any one Claude field being weak.
//
//   3. Z-normalized scoring. Visual cosines (0.1-0.4 typical) and vibe cosines
//      (0.05-0.25 typical) live on different scales. Weighting raw cosines lets
//      the bigger-magnitude scale dominate regardless of the configured weight.
//      Z-score per pool first, then weight.
//
//   4. Personal centroid axis. The user's cross-session styleCentroid (built
//      from previous DNAs / liked items) joins the rerank as a third axis:
//      score = 0.6 × z(qDescriptor↔visual) + 0.15 × z(qDescriptor↔vibe)
//                                          + 0.25 × z(centroid↔visual).
//      Items aligned with both query AND personal taste win. New users with no
//      centroid: third term zero'd, weights renormalized.
//
//   5. MMR diversity rerank. After scoring, take top-K with a marginal-
//      relevance penalty so we don't return 10 nearly-identical items from the
//      same brand/color. λ=0.3 by default — moderate diversity bonus.
//
// Fallback: only when both Algolia AND Pinecone return empty for a category
// (very rare). Falls back to parallel-RRF hybridSearch.
export async function twoStageStrictSearch(
  aesthetic:      StyleDNA,
  userToken:      string,
  maxPerCategory  = 50,
  opts:           {
    fallbackEmbeddings?: number[][];
    useTasteHead?:       boolean;
    userCentroid?:       number[] | null;
    softAvoids?:         string[];
  } = {},
): Promise<CategoryCandidates> {
  const userCentroid = opts.userCentroid && opts.userCentroid.length > 0 ? opts.userCentroid : null;

  // Encode the descriptor first (smart fallback), in parallel with the
  // retrieval-phrase ensemble used for the FashionCLIP-side gate. Both end up
  // as Promises we await alongside the Algolia request.
  const [descriptorVec, gateEmbeddings] = await Promise.all([
    buildStage2QueryVector(aesthetic),
    buildTextQueryVectors(aesthetic, opts.softAvoids ?? []).catch(() => [] as number[][]),
  ]);

  // Stage 1a (Algolia literal gate) and Stage 1b (FashionCLIP semantic gate)
  // run in parallel. searchByCategory paginates per-category up to ~5000
  // hits per query; searchByEmbeddings clusters retrieval_phrase vectors and
  // pulls topK from Pinecone's visual namespace.
  const [algoliaCandidates, semanticIds] = await Promise.all([
    searchByCategory(
      aesthetic.category_queries,
      aesthetic.style_keywords ?? [],
      aesthetic.price_range ?? "mid",
      maxPerCategory * 4,
      userToken,
    ).catch((err) => {
      console.warn("[twoStage] Algolia gate failed:", err instanceof Error ? err.message : err);
      return emptyBuckets();
    }),

    gateEmbeddings.length > 0
      ? searchByEmbeddings(gateEmbeddings, GATE_PINECONE_TOPK, {
          priceRange: aesthetic.price_range,
          minScore:   STAGE1B_MIN_SCORE,
        }).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ]);

  // Hydrate the FashionCLIP-only ids (those Algolia missed). Some will
  // overlap with Algolia hits — that's fine, the per-category dedup below
  // handles it. Skip the fetch entirely when there are no semantic ids.
  const algoliaIdSet = new Set(Object.values(algoliaCandidates).flat().map((p) => p.objectID));
  const semanticOnlyIds = semanticIds.filter((id) => !algoliaIdSet.has(id));
  const semanticOnlyProducts = semanticOnlyIds.length > 0
    ? await getProductsByIds(semanticOnlyIds).catch(() => [] as AlgoliaProduct[])
    : [];

  // Bucket semantic-only adds into per-category lists, capped per category
  // so very abstract queries don't drown the literal-gate items.
  const semanticBuckets = groupByCategory(semanticOnlyProducts, GATE_SEMANTIC_PER_CAT);

  // Merged pool per category = Algolia ∪ Semantic-only. Algolia order is
  // preserved at the front so its relevance ranking still influences ties.
  const mergedPool: Record<ClothingCategory, AlgoliaProduct[]> = emptyBuckets();
  for (const cat of CATEGORIES) {
    const seen = new Set<string>();
    const out: AlgoliaProduct[] = [];
    for (const p of algoliaCandidates[cat]) {
      if (!seen.has(p.objectID)) { seen.add(p.objectID); out.push(p); }
    }
    for (const p of semanticBuckets[cat]) {
      if (!seen.has(p.objectID)) { seen.add(p.objectID); out.push(p); }
    }
    mergedPool[cat] = out;
  }

  const totalPool = Object.values(mergedPool).reduce((s, b) => s + b.length, 0);
  const totalAlg  = Object.values(algoliaCandidates).flat().length;
  const totalSem  = Object.values(semanticBuckets).flat().length;

  // Both gates dry → fall back to the parallel-RRF hybridSearch. Should be
  // rare with the augmented gate (we'd need a query both Algolia AND
  // FashionCLIP retrieval_phrases couldn't match anything for).
  if (totalPool < STAGE2_MIN_POOL) {
    console.log(`[twoStage] augmented pool=${totalPool} < ${STAGE2_MIN_POOL} — falling back to hybridSearch`);
    return hybridSearch(
      opts.fallbackEmbeddings ?? [],
      aesthetic,
      userToken,
      maxPerCategory,
      { useTasteHead: opts.useTasteHead, strict: true },
    );
  }

  // No descriptor vector available → degrade to gate order (Algolia first, then
  // semantic). Better than blowing up.
  if (descriptorVec.length === 0) {
    console.warn("[twoStage] descriptor vector empty — using gate order");
    const out = emptyBuckets();
    for (const cat of CATEGORIES) out[cat] = mergedPool[cat].slice(0, maxPerCategory);
    return out;
  }

  // Fetch (visual, vibe) vector pair for the entire merged pool.
  const allIds  = Object.values(mergedPool).flat().map((p) => p.objectID);
  const vectors = await fetchVisualAndVibeVectors(allIds);
  const vecById = new Map(vectors.map((v) => [v.id, v]));

  console.log(
    `[twoStage] descriptor="${descriptorTextForLogging(aesthetic).slice(0, 60)}" ` +
    `pool=${totalPool} (algolia=${totalAlg} sem-only=${totalSem}) ` +
    `with-visual=${vectors.filter((v) => v.visual).length} with-vibe=${vectors.filter((v) => v.vibe).length} ` +
    `centroid=${userCentroid ? "on" : "off"}`
  );

  // Stage 2: per-category rerank with z-normalized + centroid-aware scoring,
  // then MMR diversity pass.
  const merged = emptyBuckets();
  for (const cat of CATEGORIES) {
    const candidates = mergedPool[cat];
    if (candidates.length === 0) continue;
    merged[cat] = rerankCategory(
      candidates,
      vecById,
      descriptorVec,
      userCentroid,
      maxPerCategory,
    );
  }

  return merged;
}

// ── Stage 2 helpers ───────────────────────────────────────────────────────────

const GATE_PINECONE_TOPK   = 1500;  // wide net for the FashionCLIP gate
const GATE_SEMANTIC_PER_CAT = 200;  // cap semantic-only adds per category
const STAGE1B_MIN_SCORE     = 0.18; // floor on FashionCLIP-side gate

// MMR rerank — λ controls diversity vs relevance.
//   λ=0   → strict relevance ordering (no diversity penalty, original sort)
//   λ=0.3 → moderate diversity (default)
//   λ=0.5 → aggressive diversity, may push lower-relevance items up
const MMR_LAMBDA = 0.3;

// Score axis weights — applied to z-normalized cosines so the magnitudes are
// comparable. New users with no centroid: γ folds back into α via renorm.
const W_DESCRIPTOR_VISUAL = 0.6;
const W_DESCRIPTOR_VIBE   = 0.15;
const W_CENTROID_VISUAL   = 0.25;

/**
 * Multi-tier descriptor → query vector. Falls through tiers if a tier is
 * empty or its encoding fails. Matches Claude's progressively-weaker fields
 * in order of soft-aesthetic specificity.
 */
async function buildStage2QueryVector(aesthetic: StyleDNA): Promise<number[]> {
  // Tier 1 — Claude's purified descriptor (the canonical path)
  const descriptor = (aesthetic.aesthetic_descriptor ?? "").trim();
  if (descriptor) {
    const v = await embedTextQuery(descriptor).catch(() => [] as number[]);
    if (v.length > 0) return v;
  }

  // Tier 2 — primary_aesthetic + mood (still soft-only)
  const moodPhrase = [aesthetic.primary_aesthetic ?? "", aesthetic.mood ?? ""]
    .filter((s) => Boolean(s?.trim()))
    .join(", ")
    .trim();
  if (moodPhrase) {
    const v = await embedTextQuery(moodPhrase).catch(() => [] as number[]);
    if (v.length > 0) return v;
  }

  // Tier 3 — average of retrieval_phrases (richest signal but contains
  // garment/color/fabric, so used only as a fallback ensemble)
  const phrases = (aesthetic.retrieval_phrases ?? [])
    .filter((p): p is string => Boolean(p?.trim()))
    .slice(0, 5);
  if (phrases.length > 0) {
    const vecs = await Promise.all(
      phrases.map((p) => embedTextQuery(p).catch(() => [] as number[])),
    );
    const valid = vecs.filter((v) => v.length > 0);
    if (valid.length > 0) {
      const dim = valid[0].length;
      const avg = new Array<number>(dim).fill(0);
      for (const v of valid) for (let i = 0; i < dim; i++) avg[i] += v[i] / valid.length;
      // Renormalize the average to unit length so it sits in the same shell as
      // the per-item vectors (which are L2-normalized at boundary).
      let n = 0;
      for (const x of avg) n += x * x;
      const norm = Math.sqrt(n);
      return norm === 0 ? avg : avg.map((x) => x / norm);
    }
  }

  // Tier 4 — summary (last resort, full editorial sentence)
  const summary = (aesthetic.summary ?? "").trim();
  if (summary) {
    const v = await embedTextQuery(summary).catch(() => [] as number[]);
    if (v.length > 0) return v;
  }

  return [];
}

function descriptorTextForLogging(aesthetic: StyleDNA): string {
  return (aesthetic.aesthetic_descriptor ?? "").trim()
    || [aesthetic.primary_aesthetic, aesthetic.mood].filter(Boolean).join(", ").trim()
    || (aesthetic.summary ?? "").trim()
    || "(empty)";
}

/**
 * Z-normalize an array of scores. Mean → 0, std → 1. Items missing a score
 * (NaN passed in) keep NaN so the downstream weighting can ignore them.
 * Returns zeros if the input is degenerate (all the same value).
 */
function zNormalize(scores: number[]): number[] {
  const valid = scores.filter((s) => Number.isFinite(s));
  if (valid.length === 0) return scores.map(() => 0);
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + (v - mean) ** 2, 0) / valid.length;
  const std = Math.sqrt(variance);
  if (std < 1e-9) return scores.map(() => 0);
  return scores.map((s) => (Number.isFinite(s) ? (s - mean) / std : 0));
}

/**
 * Per-category rerank: z-normalized weighted cosine score → MMR diversity.
 *
 * Scoring axes (z-normalized within this pool, so magnitudes are comparable):
 *   z(cos(query, visual))   weight 0.6
 *   z(cos(query, vibe))     weight 0.15
 *   z(cos(centroid, visual)) weight 0.25  (user has a centroid)
 *
 * If the user has no centroid the third axis is zero-weighted and the first
 * two weights are renormalized so they still sum to 1.
 *
 * MMR pass: take top-K with marginal-relevance penalty so we don't return
 * 10 visually-near-identical items.
 */
function rerankCategory(
  candidates:    AlgoliaProduct[],
  vecById:       Map<string, { visual: number[] | null; vibe: number[] | null }>,
  queryVec:      number[],
  userCentroid:  number[] | null,
  maxPerCategory: number,
): AlgoliaProduct[] {
  // Raw cosine scores per axis. Use NaN for "missing vector" so zNormalize
  // can ignore them; we coerce to 0 when combining.
  const visScores: number[]  = [];
  const vibScores: number[]  = [];
  const centScores: number[] = [];
  for (const p of candidates) {
    const v = vecById.get(p.objectID);
    visScores.push(v?.visual ? cosineSimilarity(queryVec, v.visual) : NaN);
    vibScores.push(v?.vibe   ? cosineSimilarity(queryVec, v.vibe)   : NaN);
    centScores.push(userCentroid && v?.visual ? cosineSimilarity(userCentroid, v.visual) : NaN);
  }

  const zVis  = zNormalize(visScores);
  const zVibe = zNormalize(vibScores);
  const zCent = zNormalize(centScores);

  // Renormalize axis weights when centroid axis is unavailable.
  let wVis = W_DESCRIPTOR_VISUAL, wVibe = W_DESCRIPTOR_VIBE, wCent = W_CENTROID_VISUAL;
  if (!userCentroid) {
    const sum = wVis + wVibe;  // renorm to 1.0 across just the two query axes
    wVis  = wVis  / sum;
    wVibe = wVibe / sum;
    wCent = 0;
  }

  const scored = candidates.map((p, i) => ({
    product: p,
    score:   wVis * zVis[i] + wVibe * zVibe[i] + wCent * zCent[i],
    visual:  vecById.get(p.objectID)?.visual ?? null,
  }));

  scored.sort((a, b) => b.score - a.score);

  // MMR rerank — for each remaining slot, pick the candidate that maximizes
  // (relevance) - λ × max-similarity-to-already-chosen. We use the visual
  // vector as the similarity space (most representative). Items with no
  // visual vector skip the diversity penalty (max sim treated as 0).
  if (MMR_LAMBDA <= 0 || scored.length <= 1) {
    return scored.slice(0, maxPerCategory).map((s) => s.product);
  }

  const out: typeof scored = [];
  const remaining = scored.slice();
  while (out.length < maxPerCategory && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i];
      let maxSim = 0;
      if (r.visual) {
        for (const s of out) {
          if (!s.visual) continue;
          const sim = cosineSimilarity(r.visual, s.visual);
          if (sim > maxSim) maxSim = sim;
        }
      }
      const mmr = r.score - MMR_LAMBDA * maxSim;
      if (mmr > bestMmr) { bestMmr = mmr; bestIdx = i; }
    }
    out.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return out.map((s) => s.product);
}
