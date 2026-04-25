/**
 * Taste-centroid math for the shop adaptation pipeline.
 *
 * Builds a single unit-length CLIP query vector from session signals:
 *   - Saves contribute 2× a like (deliberate vs impulsive).
 *   - Within each kind, recency decays older signals exponentially so the
 *     user's *current* taste outweighs anything they liked 10 minutes ago.
 *   - A negative centroid built from disliked vectors is subtracted, so the
 *     query literally moves *away* from the avoid set in CLIP space —
 *     not just bans the brand/category metadata.
 *
 * Inputs are vectors-only (objectID → vector lookup happens upstream in
 * the shop-all route via Pinecone fetch). Output is a single normalized
 * vector ready for `searchByEmbeddings([vec], k)`.
 */
import { subtractCentroid } from "./embeddings";

export interface WeightedSignal {
  vector: number[];
  weight: number;
}

// Tunable: a save is treated as 2× a like in the centroid weight.
// Saves are deliberate ("add to my shortlist"); likes are impulsive
// (heart-tap during scroll). Same shape, different conviction.
export const SAVE_WEIGHT = 2.0;

// Most recent signal weights 1.0; the next decays by RECENCY_DECAY each
// position. With 0.85: position 0 = 1.00, 1 = 0.85, 2 = 0.72, … 10 = 0.20.
// Means a like from the start of a session is still ~10–20% of "now."
export const RECENCY_DECAY = 0.85;

// Strength of the negative-subtraction. Above ~0.5 the resulting vector
// flips direction in CLIP space and returns nonsense. 0.4 is a strong
// nudge without that risk; passes through to subtractCentroid as `weight`.
export const NEGATIVE_ALPHA = 0.4;

/**
 * Build a unit-length positive centroid from saves and likes.
 * Both arrays should be ordered MOST RECENT FIRST.
 *
 * Returns null if no usable vectors. Caller falls back to whatever
 * Algolia returns (no CLIP boost).
 */
export function buildPositiveCentroid(
  savedVectors: number[][],
  likedVectors: number[][],
): number[] | null {
  const signals: WeightedSignal[] = [];
  savedVectors.forEach((v, i) => {
    if (!v || v.length === 0) return;
    signals.push({ vector: v, weight: SAVE_WEIGHT * Math.pow(RECENCY_DECAY, i) });
  });
  likedVectors.forEach((v, i) => {
    if (!v || v.length === 0) return;
    signals.push({ vector: v, weight: 1.0 * Math.pow(RECENCY_DECAY, i) });
  });
  if (signals.length === 0) return null;
  return weightedMean(signals);
}

/**
 * Build a unit-length negative centroid from disliked vectors.
 * Disliked = fast-swipes captured by `dislikedSignalsRef` on the client.
 * Most-recent-first ordering, same exponential decay as positives.
 */
export function buildNegativeCentroid(
  dislikedVectors: number[][],
): number[] | null {
  if (dislikedVectors.length === 0) return null;
  const signals: WeightedSignal[] = dislikedVectors
    .filter((v) => v && v.length > 0)
    .map((v, i) => ({ vector: v, weight: Math.pow(RECENCY_DECAY, i) }));
  if (signals.length === 0) return null;
  return weightedMean(signals);
}

/**
 * Apply negative subtraction: positive - alpha * negative, normalized.
 * Reuses `subtractCentroid` from lib/embeddings; this function is a thin
 * wrapper that picks our chosen alpha and tolerates a null negative.
 */
export function applyNegativeSubtraction(
  positive: number[],
  negative: number[] | null,
): number[] {
  if (!negative || negative.length === 0) return positive;
  return subtractCentroid(positive, [negative], NEGATIVE_ALPHA);
}

/**
 * One-call helper that runs the full positive + negative pipeline.
 * Returns null when neither saves nor likes produced anything.
 */
export function buildSessionCentroid(opts: {
  savedVectors:    number[][];
  likedVectors:    number[][];
  dislikedVectors: number[][];
}): number[] | null {
  const positive = buildPositiveCentroid(opts.savedVectors, opts.likedVectors);
  if (!positive) return null;
  const negative = buildNegativeCentroid(opts.dislikedVectors);
  return applyNegativeSubtraction(positive, negative);
}

/**
 * Blend the session centroid with a separate steer text centroid (CLIP's
 * text encoder embedding of the user's freeform "more elegant", "less
 * casual" steer). 70/30 visual:text by default — keeps visual taste as
 * the anchor while letting text nudge the direction.
 */
export function blendWithSteerText(
  visual:    number[] | null,
  steerText: number[] | null,
  textWeight = 0.3,
): number[] | null {
  if (!visual && !steerText)               return null;
  if (!steerText || steerText.length === 0) return visual;
  if (!visual    || visual.length    === 0) return steerText;
  const out = visual.map((v, i) => (1 - textWeight) * v + textWeight * (steerText[i] ?? 0));
  // Re-normalize after blending so cosine distance behaves well downstream.
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm);
  return norm === 0 ? out : out.map((x) => x / norm);
}

// ── Internals ───────────────────────────────────────────────────────────────

function weightedMean(signals: WeightedSignal[]): number[] {
  const dim = signals[0].vector.length;
  const total = signals.reduce((s, x) => s + x.weight, 0);
  if (total === 0) return signals[0].vector;
  const out = new Array<number>(dim).fill(0);
  for (const s of signals) {
    const w = s.weight / total;
    for (let i = 0; i < dim; i++) out[i] += s.vector[i] * w;
  }
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm);
  return norm === 0 ? out : out.map((x) => x / norm);
}

// ── StyleAxes preference tracking ───────────────────────────────────────────
// The catalog tags every product with five 0–1 axes (formality, minimalism,
// edge, romance, drape). Compute the user's preferred axis values from the
// metadata of their saved + liked products, weighted the same way as the
// vector centroid. Use as a soft filter: products whose axes land within
// ±AXIS_RADIUS of the user's mean float up.

export const AXIS_KEYS = ["formality", "minimalism", "edge", "romance", "drape"] as const;
export type AxisKey = typeof AXIS_KEYS[number];

export type AxisRecord = Partial<Record<AxisKey, number>>;

const AXIS_RADIUS = 0.25; // ±0.25 around user's mean = the "preferred" band

/**
 * Compute the user's preferred axis values from positive signals.
 * Saved metadata is weighted SAVE_WEIGHT × RECENCY_DECAY^i; liked is
 * 1.0 × RECENCY_DECAY^i. Only axes with at least one observation
 * contribute; sparse axes are returned undefined and the caller should
 * not filter on them.
 */
export function buildAxisProfile(
  savedAxes: AxisRecord[],
  likedAxes: AxisRecord[],
): AxisRecord {
  const sums:    Partial<Record<AxisKey, number>> = {};
  const weights: Partial<Record<AxisKey, number>> = {};

  const accumulate = (records: AxisRecord[], baseWeight: number) => {
    records.forEach((r, i) => {
      const w = baseWeight * Math.pow(RECENCY_DECAY, i);
      for (const k of AXIS_KEYS) {
        const v = r?.[k];
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        sums[k]    = (sums[k]    ?? 0) + w * v;
        weights[k] = (weights[k] ?? 0) + w;
      }
    });
  };
  accumulate(savedAxes, SAVE_WEIGHT);
  accumulate(likedAxes, 1.0);

  const out: AxisRecord = {};
  for (const k of AXIS_KEYS) {
    const w = weights[k] ?? 0;
    if (w > 0) out[k] = (sums[k]! / w);
  }
  return out;
}

/**
 * Convert an axis profile into a Pinecone-style range filter:
 *   { formality: { $gte: mean-r, $lte: mean+r }, ... }
 * Skip axes whose preferred band would cover the entire 0–1 range
 * anyway — no point filtering in that case.
 */
export function axisProfileToFilter(profile: AxisRecord): Record<string, unknown> | null {
  const filters: Record<string, unknown> = {};
  let any = false;
  for (const k of AXIS_KEYS) {
    const m = profile[k];
    if (typeof m !== "number") continue;
    const lo = Math.max(0, m - AXIS_RADIUS);
    const hi = Math.min(1, m + AXIS_RADIUS);
    // Whole [0,1] = no useful constraint.
    if (lo <= 0.001 && hi >= 0.999) continue;
    filters[k] = { $gte: lo, $lte: hi };
    any = true;
  }
  return any ? filters : null;
}

/**
 * Score a single product's axes against the user's profile.
 * 1.0 = perfect match (every axis at the user's preferred value),
 * 0.0 = maximally distant on every axis the user has a preference for.
 * Axes the user has no preference for don't penalize.
 */
export function scoreAxisMatch(
  productAxes: AxisRecord,
  profile:     AxisRecord,
): number {
  let total = 0;
  let count = 0;
  for (const k of AXIS_KEYS) {
    const m = profile[k];
    const v = productAxes?.[k];
    if (typeof m !== "number" || typeof v !== "number") continue;
    const dist = Math.abs(m - v);
    total += 1 - dist; // dist is in [0,1], so score is in [0,1]
    count += 1;
  }
  return count > 0 ? total / count : 0.5;
}
