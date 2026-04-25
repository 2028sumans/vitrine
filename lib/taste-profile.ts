/**
 * User taste vector composition.
 *
 * One question, one answer: given a user_token, what's the best single
 * 512-dim vector to use as their query against Pinecone? This module is the
 * centralized answer — everything downstream (shop category ranking, brand
 * ordering, tailor-your-taste seed) imports `loadUserTasteVector`.
 *
 * Composition
 * -----------
 *   A user's vector is a weighted L2-normalized average of up to four sources:
 *
 *     1. Onboarding upload centroid  — hand-picked images from the quiz.
 *                                       Strongest explicit signal, weight 1.0.
 *     2. Age-range golden centroid   — mean of items hand-labeled as this
 *                                       user's age. Lower-confidence prior
 *                                       (demographic, not personal), weight 0.4.
 *     3. Session/DNA taste centroid  — the "tailor your taste" flow's output
 *                                       (lib/taste-memory.saveStyleCentroid).
 *                                       Reflects active engagement, weight 0.8.
 *     4. Inferred-style centroid     — top-2 catalog aesthetics nearest to the
 *                                       user's upload centroid, blended into
 *                                       a single style anchor. Weight 0.3 —
 *                                       low because it's a derived signal.
 *                                       Only fires when an upload centroid is
 *                                       present; for age-only / skipped users
 *                                       the age centroid already encodes
 *                                       style and re-deriving it is a no-op.
 *
 *   We missing-source-degrade gracefully: if a user skipped onboarding, their
 *   vector is just the age + session centroids. If they're a brand-new user
 *   who just finished onboarding, it's upload + age + inferred-style. If
 *   nothing's available (anon / no session), we return null and callers fall
 *   back to non-personal ranking.
 *
 * Weights are tuned for a cold-start-heavy product. As the taste-memory
 * pipeline matures, the session weight should probably grow relative to
 * the onboarding upload weight (active > declared preferences).
 */

import ageCentroids   from "@/lib/age-centroids.json";
import styleCentroids from "@/lib/style-centroids.json";
import { getStyleCentroid } from "@/lib/taste-memory";
import { getOnboarding, type AgeRangeKey } from "@/lib/onboarding-memory";

interface FlatCentroidsFile {
  version:      number;
  dim:          number;
  builtAt:      string | null;
  sampleCounts: Record<string, number>;
  centroids:    Record<string, number[] | null>;
}

// New per-category schema (v2) for age centroids: one age-centroid map
// per catalog category. Style centroids stay flat — they aren't categorized.
interface PerCategoryCentroidsFile {
  version:     number;
  dim:         number;
  builtAt:     string | null;
  perCategory: Record<string, {
    sampleCounts: Record<string, number>;
    centroids:    Record<string, number[] | null>;
  }>;
}

const AGE:   PerCategoryCentroidsFile = ageCentroids   as unknown as PerCategoryCentroidsFile;
const STYLE: FlatCentroidsFile        = styleCentroids as unknown as FlatCentroidsFile;

// Per-source weights. Change in one place — see composition comment above.
const WEIGHTS = {
  upload:  1.0,
  age:     0.4,
  session: 0.8,
  style:   0.3,
} as const;

// How many style centroids to blend into the inferred-style anchor.
// 2 is the sweet spot: 1 is too sharp (a user nearest to "minimalist" gets
// pulled hard toward minimalist even if they're equally close to "elegant"),
// 3+ averages out into something close to the catalog mean (no information).
const TOP_STYLES = 2;

// ── Vector math (tiny, local) ─────────────────────────────────────────────────

function l2(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function normalize(v: number[]): number[] {
  const n = l2(v);
  if (n === 0) return v.slice();
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * Weighted average of N vectors, each paired with a scalar weight. All input
 * vectors are normalized first so a longer vector can't silently dominate
 * (Pinecone vectors are usually L2-normalized already, but we defend).
 *
 * Returns null if:
 *   - No inputs
 *   - All inputs have length 0 (defensive — shouldn't happen in practice)
 *   - Input dims don't match (defensive — won't happen within one embedding space)
 */
export function weightedCombine(parts: Array<{ vec: number[]; weight: number }>): number[] | null {
  const nonEmpty = parts.filter((p) => Array.isArray(p.vec) && p.vec.length > 0 && p.weight > 0);
  if (nonEmpty.length === 0) return null;

  const dim = nonEmpty[0].vec.length;
  if (!nonEmpty.every((p) => p.vec.length === dim)) return null;

  const sum = new Array(dim).fill(0);
  let totalWeight = 0;
  for (const { vec, weight } of nonEmpty) {
    const nv = normalize(vec);
    for (let i = 0; i < dim; i++) sum[i] += nv[i] * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return null;
  const avg = sum.map((s) => s / totalWeight);
  return normalize(avg);
}

// ── Style inference ───────────────────────────────────────────────────────────
//
// Given a query vector (the user's upload centroid), return:
//   - a single anchor vector = weighted blend of the top-K style centroids,
//     weighted by their cosine similarity to the query
//   - the names of those styles (for debugging / breakdown)
//
// Why a blend, not a single nearest? A user near "minimalist" + "elegant"
// shouldn't get pulled fully into "minimalist" — the catalog has 12 buckets,
// real taste straddles 2-3. Blending preserves nuance while still anchoring
// to recognizable clusters.
//
// Negative-similarity styles get zero weight — we never want to pull AWAY
// from a style the user matches negatively (that would push them toward
// the centroid's antipode, which is meaningless).

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

interface InferredStyles {
  /** Combined style anchor vector. null when no styles in the file or all
   *  similarities are non-positive. */
  vector: number[] | null;
  /** Top-K style names with their cosine scores, in descending order.
   *  Returned for telemetry / breakdown — not used in the math. */
  top:    Array<{ style: string; score: number }>;
}

function inferStyleAnchor(query: number[], topK = TOP_STYLES): InferredStyles {
  const styles = STYLE.centroids ?? {};
  const scored: Array<{ style: string; vec: number[]; score: number }> = [];
  for (const [style, vec] of Object.entries(styles)) {
    if (!vec || vec.length !== query.length) continue;
    scored.push({ style, vec, score: cosine(query, vec) });
  }
  if (scored.length === 0) return { vector: null, top: [] };

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);

  // Drop non-positive similarities — pulling toward an "antipode" of a style
  // would just be noise. Could happen for genuinely off-distribution users.
  const positive = top.filter((t) => t.score > 0);
  if (positive.length === 0) return { vector: null, top: top.map((t) => ({ style: t.style, score: t.score })) };

  return {
    vector: weightedCombine(positive.map((t) => ({ vec: t.vec, weight: t.score }))),
    top:    top.map((t) => ({ style: t.style, score: t.score })),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface TasteVectorBreakdown {
  /** The composed query vector to send to Pinecone. null = no signal at all. */
  vector: number[] | null;
  /** Which sources contributed — useful for debugging + telemetry. */
  sources: {
    upload:  boolean;
    age:     AgeRangeKey | null;
    session: boolean;
    /** Top styles inferred from the upload centroid, with cosine scores.
     *  Empty array when no upload centroid → no inference attempted. */
    styles:  Array<{ style: string; score: number }>;
  };
}

/**
 * Resolve the age centroid for a user given their age range and (optionally)
 * the catalog category they're shopping. Three cases:
 *
 *   1. `categorySlug` provided AND that category has a centroid for the
 *      user's age   → use it. Most accurate path; the centroid was built
 *      from items hand-labeled within the same category.
 *
 *   2. `categorySlug` provided but missing a centroid for the user's age →
 *      average across populated categories for the same age (general age
 *      signal). Better than null while we're still labeling.
 *
 *   3. No category context (e.g., /brands, /shop picker) → average across
 *      all populated categories for the user's age.
 *
 * Returns null when no category has a centroid for that age (e.g., labeling
 * not yet started). Caller drops the age contribution and the user vector
 * is composed from upload + session only.
 */
function resolveAgeCentroid(ageRange: AgeRangeKey, categorySlug: string | null): number[] | null {
  if (!AGE.perCategory) return null;

  if (categorySlug) {
    const cat = AGE.perCategory[categorySlug];
    const direct = cat?.centroids?.[ageRange] ?? null;
    if (direct && direct.length > 0) return direct;
    // Fall through to the cross-category average — better signal than nothing.
  }

  // Average across all categories that have a centroid for this age bucket.
  const populated: number[][] = [];
  for (const cat of Object.values(AGE.perCategory)) {
    const v = cat?.centroids?.[ageRange];
    if (v && v.length > 0) populated.push(v);
  }
  if (populated.length === 0) return null;
  return weightedCombine(populated.map((vec) => ({ vec, weight: 1 })));
}

/**
 * Given a user_token, returns their current taste vector plus a breakdown of
 * which sources contributed. Hits Supabase twice (onboarding + session
 * centroid) and one local JSON file (age centroids). All three calls are
 * parallel so the wall-clock cost is max(onboarding, session) ≈ 40-80 ms.
 *
 * Optional `category` arg routes the age-centroid lookup into the matching
 * per-category bucket. When omitted (e.g., on /brands) we fall back to a
 * cross-category average for the user's age range.
 *
 * null-`userToken` / "anon" is a fast-return (no network).
 */
export async function loadUserTasteVector(
  userToken: string,
  options:   { category?: string | null } = {},
): Promise<TasteVectorBreakdown> {
  if (!userToken || userToken === "anon") {
    return { vector: null, sources: { upload: false, age: null, session: false, styles: [] } };
  }

  const [onboarding, sessionCentroid] = await Promise.all([
    getOnboarding(userToken),
    getStyleCentroid(userToken),
  ]);

  const ageRange     = onboarding?.ageRange ?? null;
  const uploadVec    = onboarding?.uploadCentroid ?? null;
  const categorySlug = options.category ?? null;
  const ageVec       = ageRange ? resolveAgeCentroid(ageRange, categorySlug) : null;

  // Style inference is gated on uploads being present — for age-only users,
  // running the age centroid through style-space and adding it back is a
  // largely-redundant transform of the same signal (age centroids are
  // already averages of items carrying these aesthetic_tags). Real value
  // comes from anchoring the personal upload signal to catalog clusters.
  let styleInference: InferredStyles = { vector: null, top: [] };
  if (uploadVec && uploadVec.length > 0) {
    styleInference = inferStyleAnchor(uploadVec);
  }

  const parts: Array<{ vec: number[]; weight: number }> = [];
  if (uploadVec && uploadVec.length > 0)               parts.push({ vec: uploadVec,              weight: WEIGHTS.upload  });
  if (ageVec    && ageVec.length    > 0)               parts.push({ vec: ageVec,                 weight: WEIGHTS.age     });
  if (sessionCentroid && sessionCentroid.length)       parts.push({ vec: sessionCentroid,        weight: WEIGHTS.session });
  if (styleInference.vector && styleInference.vector.length > 0)
                                                       parts.push({ vec: styleInference.vector,  weight: WEIGHTS.style   });

  return {
    vector: weightedCombine(parts),
    sources: {
      upload:  uploadVec != null,
      age:     ageRange,
      session: sessionCentroid != null,
      styles:  styleInference.top,
    },
  };
}

/**
 * Average a list of raw FashionCLIP vectors (e.g. the 4-8 quiz uploads) into
 * a single unit-length centroid suitable for storing as `upload_centroid`.
 * Exposed so the save-route and the build-age-centroids script use the same
 * averaging scheme.
 */
export function averageVectors(vectors: number[][]): number[] | null {
  const clean = vectors.filter((v) => Array.isArray(v) && v.length > 0);
  return weightedCombine(clean.map((vec) => ({ vec, weight: 1 })));
}
