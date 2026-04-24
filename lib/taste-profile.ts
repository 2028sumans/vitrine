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
 *   A user's vector is a weighted L2-normalized average of up to three sources:
 *
 *     1. Onboarding upload centroid  — hand-picked images from the quiz.
 *                                       Strongest explicit signal, weight 1.0.
 *     2. Age-range golden centroid   — mean of items hand-labeled as this
 *                                       user's age. Lower-confidence prior
 *                                       (demographic, not personal), weight 0.4.
 *     3. Session/DNA taste centroid  — the "tailor your taste" flow's output
 *                                       (lib/taste-memory.saveStyleCentroid).
 *                                       Reflects active engagement, weight 0.8.
 *
 *   We missing-source-degrade gracefully: if a user skipped onboarding, their
 *   vector is just the age + session centroids. If they're a brand-new user
 *   who just finished onboarding, it's upload + age. If nothing's available
 *   (anon / no session), we return null and callers fall back to non-personal
 *   ranking.
 *
 * Weights are tuned for a cold-start-heavy product. As the taste-memory
 * pipeline matures, the session weight should probably grow relative to
 * the onboarding upload weight (active > declared preferences).
 */

import ageCentroids from "@/lib/age-centroids.json";
import { getStyleCentroid } from "@/lib/taste-memory";
import { getOnboarding, type AgeRangeKey } from "@/lib/onboarding-memory";

interface AgeCentroidFile {
  version:      number;
  dim:          number;
  builtAt:      string | null;
  sampleCounts: Record<string, number>;
  centroids:    Record<string, number[] | null>;
}

// The JSON import widens all fields to `any`; narrow once at module load so
// the rest of the file gets type support.
const AGE: AgeCentroidFile = ageCentroids as unknown as AgeCentroidFile;

// Per-source weights. Change in one place — see composition comment above.
const WEIGHTS = {
  upload:  1.0,
  age:     0.4,
  session: 0.8,
} as const;

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

// ── Public API ────────────────────────────────────────────────────────────────

export interface TasteVectorBreakdown {
  /** The composed query vector to send to Pinecone. null = no signal at all. */
  vector: number[] | null;
  /** Which sources contributed — useful for debugging + telemetry. */
  sources: {
    upload:  boolean;
    age:     AgeRangeKey | null;
    session: boolean;
  };
}

/**
 * Given a user_token, returns their current taste vector plus a breakdown of
 * which sources contributed. Hits Supabase twice (onboarding + session
 * centroid) and one local JSON file (age centroids). All three calls are
 * parallel so the wall-clock cost is max(onboarding, session) ≈ 40-80 ms.
 *
 * null-`userToken` / "anon" is a fast-return (no network).
 */
export async function loadUserTasteVector(userToken: string): Promise<TasteVectorBreakdown> {
  if (!userToken || userToken === "anon") {
    return { vector: null, sources: { upload: false, age: null, session: false } };
  }

  const [onboarding, sessionCentroid] = await Promise.all([
    getOnboarding(userToken),
    getStyleCentroid(userToken),
  ]);

  const ageRange   = onboarding?.ageRange ?? null;
  const uploadVec  = onboarding?.uploadCentroid ?? null;
  const ageVec     = ageRange ? (AGE.centroids?.[ageRange] ?? null) : null;

  const parts: Array<{ vec: number[]; weight: number }> = [];
  if (uploadVec && uploadVec.length > 0)          parts.push({ vec: uploadVec,       weight: WEIGHTS.upload  });
  if (ageVec    && ageVec.length    > 0)          parts.push({ vec: ageVec,          weight: WEIGHTS.age     });
  if (sessionCentroid && sessionCentroid.length)  parts.push({ vec: sessionCentroid, weight: WEIGHTS.session });

  return {
    vector: weightedCombine(parts),
    sources: {
      upload:  uploadVec != null,
      age:     ageRange,
      session: sessionCentroid != null,
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
