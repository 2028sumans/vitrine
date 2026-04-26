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
import { classifyQuery, type QueryClassification } from "@/lib/query-classifier";
import type { StyleDNA, ClickSignal } from "@/lib/types";

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
    clickSignals?:       ClickSignal[];
    /** Raw user query string — drives query-type classification (#3, #5). */
    userQuery?:          string;
    /** Debug mode — attach per-item _debug breakdown to surviving products. */
    debug?:              boolean;
  } = {},
): Promise<CategoryCandidates> {
  const userCentroid = opts.userCentroid && opts.userCentroid.length > 0 ? opts.userCentroid : null;
  const clickSignals = opts.clickSignals ?? [];
  const debug        = opts.debug === true;

  // (#3) Query-type classification. Drives whether we run stage 1b at all and
  // (#5) what MMR λ to use. Empty / non-text queries get "abstract" so the
  // full pipeline still runs.
  const classification = await classifyQuery(opts.userQuery);
  const skipStage1b    = classification.type === "literal";
  const mmrLambda      = classification.type === "literal" ? 0.10
                       : classification.type === "mixed"   ? 0.30
                       :                                     0.40;
  console.log(
    `[twoStage] classify="${(opts.userQuery ?? "").slice(0, 60)}" ` +
    `type=${classification.type} (brand=${classification.hasBrand} garment=${classification.hasGarment} color=${classification.hasColor}) ` +
    `skip1b=${skipStage1b} mmr=${mmrLambda}`
  );

  // Encode the descriptor first (smart fallback), in parallel with the
  // retrieval-phrase ensemble used for the FashionCLIP-side gate. Both end up
  // as Promises we await alongside the Algolia request.
  const [descriptorVec, gateEmbeddings] = await Promise.all([
    buildStage2QueryVector(aesthetic),
    buildTextQueryVectors(aesthetic, opts.softAvoids ?? []).catch(() => [] as number[][]),
  ]);

  // (E) Per-category Pinecone gate: run 6 parallel category-filtered semantic
  // searches instead of one flat search. Each bucket gets its full topK
  // budget regardless of cross-category visual bias.
  //
  // (#1) Per-phrase variant: when we have multiple retrieval phrases, search
  // EACH phrase separately and union the ids per category, instead of letting
  // searchByEmbeddings cluster them into one centroid that lands somewhere
  // generic between facets. For "y2k party" with phrases "low-rise jeans",
  // "metallic top", "rhinestone tank" — each gets its own topK and all three
  // facets surface.
  //
  // (#3) Skip stage 1b entirely for literal queries (brand-mentioned, garment-
  // specific, color-specific). Algolia is exhaustive for those; the semantic
  // gate just adds latency without finding new items.
  //
  // Stage 1a (Algolia) and Stage 1b (FashionCLIP per-phrase × per-category)
  // run in parallel via Promise.all.
  const semanticGate = (skipStage1b || gateEmbeddings.length === 0)
    ? Promise.resolve(CATEGORIES.map((cat) => ({ cat, ids: [] as string[] })))
    : Promise.all(
        CATEGORIES.map(async (cat) => {
          // Per-phrase searches in parallel within this category. Each one
          // returns up to GATE_PINECONE_TOPK_PER_PHRASE; we union and
          // deduplicate, then truncate to GATE_PINECONE_TOPK_PER_CAT total.
          const perPhrase = await Promise.all(
            gateEmbeddings.map((vec) =>
              searchByEmbeddings([vec], GATE_PINECONE_TOPK_PER_PHRASE, {
                priceRange: aesthetic.price_range,
                minScore:   STAGE1B_MIN_SCORE,
                categories: [cat],
              }).catch(() => [] as string[])
            ),
          );
          const seen = new Set<string>();
          const ids: string[] = [];
          for (const list of perPhrase) {
            for (const id of list) {
              if (seen.has(id)) continue;
              seen.add(id);
              ids.push(id);
              if (ids.length >= GATE_PINECONE_TOPK_PER_CAT) break;
            }
            if (ids.length >= GATE_PINECONE_TOPK_PER_CAT) break;
          }
          return { cat, ids };
        }),
      );

  const [algoliaCandidates, perCatSemantic] = await Promise.all([
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
    semanticGate,
  ]);

  // Hydrate the union of all FashionCLIP-only ids (those Algolia missed).
  const algoliaIdSet = new Set(Object.values(algoliaCandidates).flat().map((p) => p.objectID));
  const allSemanticOnly = new Set<string>();
  const semanticIdsByCat = new Map<ClothingCategory, string[]>();
  for (const { cat, ids } of perCatSemantic) {
    const filtered = ids.filter((id) => !algoliaIdSet.has(id));
    semanticIdsByCat.set(cat, filtered);
    for (const id of filtered) allSemanticOnly.add(id);
  }

  const semanticOnlyProducts = allSemanticOnly.size > 0
    ? await getProductsByIds(Array.from(allSemanticOnly)).catch(() => [] as AlgoliaProduct[])
    : [];
  const semProductById = new Map(semanticOnlyProducts.map((p) => [p.objectID, p]));

  // (A) Cap pool per category: top GATE_ALGOLIA_PER_CAT from Algolia (relevance
  // order preserved by searchProducts) ∪ top GATE_SEMANTIC_PER_CAT from
  // FashionCLIP semantic (Pinecone score order preserved by searchByEmbeddings).
  // Latency: capping at ~700/cat × 6 = 4200 max pool drops fetch round-trips
  // from ~10 to ~5 worst case.
  const mergedPool: Record<ClothingCategory, AlgoliaProduct[]> = emptyBuckets();
  for (const cat of CATEGORIES) {
    const seen = new Set<string>();
    const out: AlgoliaProduct[] = [];

    // Algolia hits, capped at GATE_ALGOLIA_PER_CAT in relevance order
    for (const p of algoliaCandidates[cat].slice(0, GATE_ALGOLIA_PER_CAT)) {
      if (!seen.has(p.objectID)) { seen.add(p.objectID); out.push(p); }
    }

    // Semantic-only adds for THIS category, capped at GATE_SEMANTIC_PER_CAT.
    // The per-category gate already filtered to just this category in
    // Pinecone, so order is correct without re-grouping.
    let semAdded = 0;
    for (const id of (semanticIdsByCat.get(cat) ?? [])) {
      if (semAdded >= GATE_SEMANTIC_PER_CAT) break;
      if (seen.has(id)) continue;
      const p = semProductById.get(id);
      if (!p) continue;
      seen.add(id);
      out.push(p);
      semAdded++;
    }

    mergedPool[cat] = out;
  }

  const totalPool = Object.values(mergedPool).reduce((s, b) => s + b.length, 0);
  const totalAlg  = Object.values(algoliaCandidates).flat().length;
  const totalSem  = Array.from(semanticIdsByCat.values()).reduce((s, ids) => s + ids.length, 0);

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
  const clickFeatures = buildClickFeatures(clickSignals);
  // Track Algolia rank per id for the (#8) tiebreaker axis. Higher = more
  // relevant per Algolia. Items not in the Algolia gate (semantic-only adds)
  // get rank=0.
  const algoliaRankById = new Map<string, number>();
  for (const cat of CATEGORIES) {
    const list = algoliaCandidates[cat];
    list.forEach((p, i) => {
      // Normalize to [0, 1] within this category — top-ranked = 1.0.
      algoliaRankById.set(p.objectID, list.length === 1 ? 1 : 1 - i / (list.length - 1));
    });
  }

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
      clickFeatures,
      algoliaRankById,
      mmrLambda,
      debug,
    );
  }

  return merged;
}

// ── Stage 2 helpers ───────────────────────────────────────────────────────────

// Per-category Pinecone topK (E). Each of 6 cats gets its own budget instead
// of competing in one flat search.
const GATE_PINECONE_TOPK_PER_CAT = 300;
// Per-phrase Pinecone topK (#1). Each retrieval phrase searches independently
// for this many ids; results are unioned per category and truncated to
// GATE_PINECONE_TOPK_PER_CAT. With 5-8 phrases × 6 cats = 30-48 parallel
// Pinecone calls per query — fast given Pinecone's per-call latency (~30 ms).
const GATE_PINECONE_TOPK_PER_PHRASE = 80;
// (A) Pool caps: cap Algolia at 500/cat (relevance order), semantic-only at
// 200/cat. Total worst-case pool ≈ 700/cat × 6 = 4200, down from ~30,000+.
const GATE_ALGOLIA_PER_CAT  = 500;
const GATE_SEMANTIC_PER_CAT = 200;
const STAGE1B_MIN_SCORE     = 0.18; // floor on FashionCLIP-side gate

// MMR rerank — λ controls diversity vs relevance.
//   λ=0   → strict relevance ordering (no diversity penalty, original sort)
//   λ=0.3 → moderate diversity (default)
//   λ=0.5 → aggressive diversity, may push lower-relevance items up
const MMR_LAMBDA = 0.3;

// Score axis weights — applied to normalized cosines so the magnitudes are
// comparable. Defaults; the rerank dynamically attenuates these per-pool
// based on (B) centroid alignment and (C) vibe vector availability.
const W_DESCRIPTOR_VISUAL = 0.6;
const W_DESCRIPTOR_VIBE   = 0.15;
const W_CENTROID_VISUAL   = 0.25;

// (B) Centroid attenuation thresholds. Compute cos(centroid, descriptor) —
// the alignment between the user's existing taste and the current query.
// When the query is OFF the user's usual taste (low alignment), shrink the
// centroid weight so it doesn't fight what they're explicitly asking for.
const CENT_ALIGN_LOW  = 0.15;  // below: centroid is ~irrelevant to query
const CENT_ALIGN_MED  = 0.30;  // between low/med: partial pull
const W_CENT_LOW      = 0.05;
const W_CENT_MED      = 0.15;
// at MED+ → keep W_CENTROID_VISUAL = 0.25

// (C) Vibe dropout: if fewer than this fraction of pool items have vibe
// vectors, drop the vibe axis entirely (its weight redistributes to visual).
// Below 50% means 1 in 2 items has a missing axis, which makes the vibe
// z-norm meaningless and silently distorts the overall ranking.
const VIBE_DROPOUT_THRESHOLD = 0.5;

// (D) Z-norm safe mode threshold. Below this pool size, std estimates are
// noisy enough that z-scores can flip rankings on outliers. Switch to rank-
// normalization (always [0, 1], stable on any pool size) for small pools.
const ZNORM_MIN_POOL = 30;

// (#8) Algolia rank tiebreaker. Algolia returns hits in its own relevance
// order which encodes brand rules, retailer popularity, and other internal
// signal. Items at top of Algolia get score 1.0, bottom 0.0; items added by
// stage 1b only (semantic-only) have no Algolia rank → 0. Small weight so
// it's a tiebreaker, not a driver.
const W_ALGOLIA_RANK = 0.05;

// Click-affinity bonus: an additive score in [0, W_CLICK_AFFINITY] applied
// to items whose brand/color/retailer matches the user's click history.
// Captures structured personal signal that the centroid (purely visual) misses
// — a user who clicks Khaite items has both a Khaite-aesthetic centroid AND
// a literal Khaite-brand affinity; this axis represents the latter.
//
// The bonus is small (0.10) so it doesn't override semantic relevance —
// among items with similar relevance scores, the brand-matched item wins;
// no item moves dramatically just for matching brand.
const W_CLICK_AFFINITY = 0.10;
const CLICK_BRAND_WEIGHT    = 0.5;
const CLICK_COLOR_WEIGHT    = 0.3;
const CLICK_RETAILER_WEIGHT = 0.2;

// (Brand-aware MMR) Penalty added to the visual-similarity penalty when an
// already-selected item shares the candidate's brand. Stops a category from
// returning 10 nearly-identical Khaite blazers even when MMR's visual penalty
// is satisfied (different colorways look visually distinct enough to slip
// past). 0.15 is enough to demote 2nd-from-same-brand without entirely
// banning brand repeats.
const MMR_BRAND_PENALTY = 0.15;

/**
 * Multi-tier descriptor → query vector. Falls through tiers if a tier is
 * empty or its encoding fails. Matches Claude's progressively-weaker fields
 * in order of soft-aesthetic specificity.
 */
async function buildStage2QueryVector(aesthetic: StyleDNA): Promise<number[]> {
  // Tier 1 — Claude's purified descriptor + its paraphrases. Encode all of
  // them in parallel, average the unit vectors, renormalize. Robust to any
  // single phrasing landing in a thin region of CLIP latent space.
  const descriptor = (aesthetic.aesthetic_descriptor ?? "").trim();
  const alts       = (aesthetic.aesthetic_descriptor_alts ?? [])
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .slice(0, 2);
  if (descriptor) {
    const phrases = [descriptor, ...alts];
    const vecs = await Promise.all(phrases.map((p) => embedTextQuery(p).catch(() => [] as number[])));
    const valid = vecs.filter((v) => v.length > 0);
    if (valid.length === 1) return valid[0];
    if (valid.length > 1) {
      const dim = valid[0].length;
      const avg = new Array<number>(dim).fill(0);
      for (const v of valid) for (let i = 0; i < dim; i++) avg[i] += v[i] / valid.length;
      let n = 0;
      for (const x of avg) n += x * x;
      const norm = Math.sqrt(n);
      return norm === 0 ? avg : avg.map((x) => x / norm);
    }
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
 * (NaN passed in) coerce to 0 so they sort to the middle. Returns zeros if
 * the input is degenerate (all the same value).
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
 * Rank-normalize an array of scores. Each valid score gets a value in [0, 1]
 * based on its sorted position. Stable across any pool size — used for small
 * pools where z-norm's std estimate is too noisy to trust. Items with NaN
 * map to 0 (treated as worst).
 *
 * Trade-off vs z-norm: loses absolute distance info (a 0.30 cosine and a
 * 0.20 cosine in the same pool are 1.0 and 0.0 even though the gap is huge),
 * but always produces stable, bounded scores. Right call for pools < 30.
 */
function rankNormalize(scores: number[]): number[] {
  const indexed: Array<{ s: number; i: number }> = [];
  for (let i = 0; i < scores.length; i++) {
    if (Number.isFinite(scores[i])) indexed.push({ s: scores[i], i });
  }
  if (indexed.length === 0) return scores.map(() => 0);
  if (indexed.length === 1) return scores.map((s) => (Number.isFinite(s) ? 1 : 0));

  indexed.sort((a, b) => a.s - b.s);  // ascending — best (highest cosine) gets rank n-1
  const out = scores.map(() => 0);
  for (let r = 0; r < indexed.length; r++) {
    out[indexed[r].i] = r / (indexed.length - 1);   // 0 (worst) to 1 (best)
  }
  return out;
}

/**
 * (D) Pool-size-aware normalization. z-norm for big pools (preserves
 * magnitude info), rank-norm for small pools (stable when std is noisy).
 * Threshold = ZNORM_MIN_POOL.
 */
function normalizeScores(scores: number[]): number[] {
  const validCount = scores.reduce((c, s) => c + (Number.isFinite(s) ? 1 : 0), 0);
  return validCount >= ZNORM_MIN_POOL ? zNormalize(scores) : rankNormalize(scores);
}

/**
 * Pre-compute the user's click-affinity feature maps — brand / color /
 * retailer → cumulative recency-weighted weight. (#7) Older clicks decay
 * exponentially with a 30-day half-life: a click 30 days ago counts half
 * as much as a click today, a click 60 days ago a quarter, etc.
 *
 * Why decay matters: a user who clicked y2k items 3 months ago and old-money
 * items yesterday should have a click-affinity score that reflects the
 * shift, not an equal sum of both. Without decay the system locks them into
 * patterns from past sessions that no longer reflect current taste.
 */
type ClickFeatures = {
  brands:    Map<string, number>;  // brand → cumulative weight
  colors:    Map<string, number>;
  retailers: Map<string, number>;
};

const CLICK_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

function recencyWeight(clickedAt: string | undefined): number {
  if (!clickedAt) return 1;  // unknown timestamp: treat as fresh
  const ts  = new Date(clickedAt).getTime();
  if (!Number.isFinite(ts)) return 1;
  const ageDays = (Date.now() - ts) / MS_PER_DAY;
  return Math.exp(-Math.LN2 * Math.max(0, ageDays) / CLICK_HALF_LIFE_DAYS);
}

function bumpFeature(map: Map<string, number>, key: string | undefined, weight: number): void {
  if (!key) return;
  const k = key.toLowerCase().trim();
  if (!k) return;
  map.set(k, (map.get(k) ?? 0) + weight);
}

function buildClickFeatures(clicks: ClickSignal[]): ClickFeatures {
  const brands    = new Map<string, number>();
  const colors    = new Map<string, number>();
  const retailers = new Map<string, number>();
  for (const c of clicks) {
    const w = recencyWeight(c.clicked_at);
    bumpFeature(brands,    c.brand,    w);
    bumpFeature(colors,    c.color,    w);
    bumpFeature(retailers, c.retailer, w);
  }
  return { brands, colors, retailers };
}

/**
 * Per-product click-affinity score in [0, 1]. Pulls the recency-weighted
 * weight from each feature map and saturates the sum at 1.
 *
 * The weight per feature is normalized by the maximum weight in that map so
 * a recent click contributes 1.0 of its category weight; stale clicks
 * contribute proportionally less. Without the per-map normalization, users
 * with heavy click history would saturate every score regardless of recency
 * profile.
 */
function clickAffinityScore(product: AlgoliaProduct, features: ClickFeatures): number {
  const allEmpty = features.brands.size === 0 && features.colors.size === 0 && features.retailers.size === 0;
  if (allEmpty) return 0;

  // tsconfig target predates ES2015 iterators, so spread over a Map iterator
  // needs an explicit Array.from materialization. Cheap — these maps are tiny.
  const brandMax    = Math.max(0, ...Array.from(features.brands.values()));
  const colorMax    = Math.max(0, ...Array.from(features.colors.values()));
  const retailerMax = Math.max(0, ...Array.from(features.retailers.values()));

  let score = 0;
  if (product.brand && brandMax > 0) {
    const w = features.brands.get(product.brand.toLowerCase().trim()) ?? 0;
    score += CLICK_BRAND_WEIGHT * (w / brandMax);
  }
  if (product.color && colorMax > 0) {
    const w = features.colors.get(product.color.toLowerCase().trim()) ?? 0;
    score += CLICK_COLOR_WEIGHT * (w / colorMax);
  }
  if (product.retailer && retailerMax > 0) {
    const w = features.retailers.get(product.retailer.toLowerCase().trim()) ?? 0;
    score += CLICK_RETAILER_WEIGHT * (w / retailerMax);
  }
  return Math.min(1, score);
}

/**
 * Per-category rerank with adaptive scoring.
 *
 *   Score = wVis × N(cos(q, vis)) + wVibe × N(cos(q, vibe)) + wCent × N(cos(c, vis))
 *
 * where N is z-norm for pools ≥ 30 and rank-norm otherwise (D), and the
 * weights are dynamically adjusted:
 *
 *   (B) Centroid attenuation. wCent shrinks toward 0 when the descriptor is
 *       far from the user's existing taste centroid (cos(centroid, query) is
 *       low). Prevents taste lock-in: a user who's mostly clicked old-money
 *       can still type "y2k party" and get y2k results.
 *
 *   (C) Vibe dropout. If fewer than 50% of pool items have a vibe vector,
 *       wVibe → 0 (its weight redistributes to wVis). Without dropout, the
 *       z-norm of a half-populated vibe column distorts the whole score.
 *
 * Final pass: MMR diversity rerank (λ = 0.3) with visual vector similarity.
 */
function rerankCategory(
  candidates:    AlgoliaProduct[],
  vecById:       Map<string, { visual: number[] | null; vibe: number[] | null }>,
  queryVec:      number[],
  userCentroid:  number[] | null,
  maxPerCategory: number,
  clickFeatures: ClickFeatures = { brands: new Map(), colors: new Map(), retailers: new Map() },
  algoliaRankById: Map<string, number> = new Map(),
  mmrLambda:     number = MMR_LAMBDA,
  debug:         boolean = false,
): AlgoliaProduct[] {
  // Raw cosine scores per axis. NaN = missing vector.
  const visScores:  number[] = [];
  const vibScores:  number[] = [];
  const centScores: number[] = [];
  let vibeCount = 0;
  for (const p of candidates) {
    const v = vecById.get(p.objectID);
    visScores.push(v?.visual ? cosineSimilarity(queryVec, v.visual) : NaN);
    if (v?.vibe) {
      vibScores.push(cosineSimilarity(queryVec, v.vibe));
      vibeCount++;
    } else {
      vibScores.push(NaN);
    }
    centScores.push(userCentroid && v?.visual ? cosineSimilarity(userCentroid, v.visual) : NaN);
  }

  // (D) Normalize each axis with the pool-size-aware function.
  const nVis  = normalizeScores(visScores);
  const nVibe = normalizeScores(vibScores);
  const nCent = normalizeScores(centScores);

  // (B) Centroid attenuation. cos(centroid, descriptor) tells us how well
  // the user's existing taste predicts the current query. Low alignment
  // means the user is reaching for something off-taste — respect that and
  // shrink the centroid axis so it doesn't drag results toward their usual.
  let wCent = userCentroid ? W_CENTROID_VISUAL : 0;
  let centAlign = NaN;
  if (userCentroid) {
    centAlign = cosineSimilarity(userCentroid, queryVec);
    if      (centAlign < CENT_ALIGN_LOW) wCent = W_CENT_LOW;
    else if (centAlign < CENT_ALIGN_MED) wCent = W_CENT_MED;
    // else keep at W_CENTROID_VISUAL (full pull, query aligns with existing taste)
  }

  // (C) Vibe dropout. Fewer than half the items have vibe vectors → axis is
  // unreliable, drop it. Its weight gets redistributed to visual.
  const vibeRatio = candidates.length > 0 ? vibeCount / candidates.length : 0;
  const useVibe   = vibeRatio >= VIBE_DROPOUT_THRESHOLD;

  // Final weights: keep visual:vibe ratio at 4:1 when both are on; visual
  // takes the freed weight when vibe drops.
  const remaining = 1 - wCent;
  let wVis: number, wVibe: number;
  if (useVibe) {
    const baseSum = W_DESCRIPTOR_VISUAL + W_DESCRIPTOR_VIBE;
    wVis  = remaining * (W_DESCRIPTOR_VISUAL / baseSum);
    wVibe = remaining * (W_DESCRIPTOR_VIBE   / baseSum);
  } else {
    wVis  = remaining;
    wVibe = 0;
  }

  // Per-pool log so we can see what knobs each query actually triggered.
  // (Only at category granularity in tight loops; aggregate is in caller.)
  const cat = candidates[0]?.category ?? "?";
  console.log(
    `[twoStage:rerank cat=${cat}] pool=${candidates.length} ` +
    `useVibe=${useVibe} (vibeRatio=${vibeRatio.toFixed(2)}) ` +
    `wCent=${wCent.toFixed(2)} ` +
    (Number.isFinite(centAlign) ? `centAlign=${centAlign.toFixed(2)} ` : "") +
    `norm=${candidates.length >= ZNORM_MIN_POOL ? "z" : "rank"}`,
  );

  // (#8) Algolia rank as a 5th tiebreaker axis. Items at top of Algolia's
  // own relevance order get a small bonus — encodes brand rules, retailer
  // popularity, and other Algolia-internal signal we'd otherwise discard.
  // Items added by stage 1b only (semantic-only) have rank=0.
  const algRanks = candidates.map((p) => algoliaRankById.get(p.objectID) ?? 0);
  // Don't normalize — already in [0, 1] from the caller's mapping.

  const scored = candidates.map((p, i) => {
    const visualCos    = visScores[i];
    const vibeCos      = vibScores[i];
    const centCos      = centScores[i];
    const clickAff     = clickAffinityScore(p, clickFeatures);
    const algoliaRank  = algRanks[i];
    const finalScore   = wVis * nVis[i] + wVibe * nVibe[i] + wCent * nCent[i]
                       + W_CLICK_AFFINITY * clickAff
                       + W_ALGOLIA_RANK   * algoliaRank;
    const debugInfo    = debug ? {
      visualCos:    Number.isFinite(visualCos)    ? Number(visualCos.toFixed(4))    : null,
      vibeCos:      Number.isFinite(vibeCos)      ? Number(vibeCos.toFixed(4))      : null,
      centroidCos:  Number.isFinite(centCos)      ? Number(centCos.toFixed(4))      : null,
      clickAffinity: Number(clickAff.toFixed(4)),
      algoliaRank:  Number(algoliaRank.toFixed(4)),
      finalScore:   Number(finalScore.toFixed(4)),
      weights:      { wVis: Number(wVis.toFixed(2)), wVibe: Number(wVibe.toFixed(2)), wCent: Number(wCent.toFixed(2)) },
    } : null;
    return {
      product: p,
      score:   finalScore,
      visual:  vecById.get(p.objectID)?.visual ?? null,
      brand:   (p.brand ?? "").toLowerCase().trim(),
      debugInfo,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  // MMR rerank — each new slot picks the candidate that maximizes:
  //   score
  //     - mmrLambda         × max-visual-sim-to-selected
  //     - MMR_BRAND_PENALTY × (already-selected-shares-brand ? 1 : 0)
  //
  // (#5) mmrLambda comes from the query classifier: literal queries → 0.10
  // (variations welcome), abstract → 0.40 (variety dominates).
  const effectiveLambda = mmrLambda;
  if (effectiveLambda <= 0 || scored.length <= 1) {
    const top = scored.slice(0, maxPerCategory);
    return top.map((s, mmrPos) => attachDebug(s.product, s.debugInfo, mmrPos, debug));
  }

  const out: typeof scored = [];
  const selectedBrands = new Set<string>();
  const remainingPool = scored.slice();
  while (out.length < maxPerCategory && remainingPool.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < remainingPool.length; i++) {
      const r = remainingPool[i];
      let maxSim = 0;
      if (r.visual) {
        for (const s of out) {
          if (!s.visual) continue;
          const sim = cosineSimilarity(r.visual, s.visual);
          if (sim > maxSim) maxSim = sim;
        }
      }
      const brandPenalty = r.brand && selectedBrands.has(r.brand) ? MMR_BRAND_PENALTY : 0;
      const mmr = r.score - effectiveLambda * maxSim - brandPenalty;
      if (mmr > bestMmr) { bestMmr = mmr; bestIdx = i; }
    }
    out.push(remainingPool[bestIdx]);
    if (remainingPool[bestIdx].brand) selectedBrands.add(remainingPool[bestIdx].brand);
    remainingPool.splice(bestIdx, 1);
  }
  return out.map((s, mmrPos) => attachDebug(s.product, s.debugInfo, mmrPos, debug));
}

/**
 * Helper: attach _debug field to a product if debug mode is on, else return
 * the product unchanged. Centralizes the conditional so we don't fork the
 * return path.
 */
function attachDebug(
  product:   AlgoliaProduct,
  debugInfo: Record<string, unknown> | null,
  mmrPos:    number,
  debug:     boolean,
): AlgoliaProduct {
  if (!debug || !debugInfo) return product;
  return {
    ...product,
    _debug: { ...debugInfo, mmrPos },
  } as AlgoliaProduct;
}
