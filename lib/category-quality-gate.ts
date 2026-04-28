/**
 * Per-category quality gate for Pinterest-mode retrieval.
 *
 * Why: hybridSearch fetches up to N products per category (dress, top,
 * bottom, jacket, shoes, bag) regardless of whether the category fits
 * the user's aesthetic. For a board that's 90% elegant burgundy dresses,
 * the system still returns 50 shoes — and the "best" shoe by visual
 * similarity is whatever shares the burgundy palette, often casual
 * sneakers that match on color but jar on vibe.
 *
 * What this does: after hybridSearch returns, score each category's top
 * product against the actual query centroid (mean of pin embeddings).
 * If the top match is below threshold, drop the entire category. The
 * threshold is intentionally conservative — categories that DO have
 * good matches stay; only the ones the catalog can't serve well get
 * dropped.
 *
 * Why "top product" only: if the top product can't clear the bar, the
 * #2-#50 in that category are by definition no better. Cheaper than
 * scoring all 50.
 *
 * Threshold tuning: 0.22 is a starting point. CLIP cosines on this
 * pipeline land in the 0.15–0.40 range for "fits the aesthetic."
 * Anything below 0.20 is firmly "matched on a single feature (usually
 * color) but the rest of the vibe is wrong." 0.22 cuts those without
 * being so aggressive it kills ambiguous-but-plausible matches.
 */

import { fetchVisualAndVibeVectors, cosineSimilarity } from "@/lib/embeddings";
import type { CategoryCandidates, ClothingCategory } from "@/lib/algolia";

const CATEGORIES: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];
const DEFAULT_THRESHOLD = 0.22;

/** Mean of unit vectors followed by L2 renormalization. Operates in
 *  Float64 to keep numerical drift below CLIP-similarity-tier
 *  resolution; output goes back to plain number[] for compat with
 *  cosineSimilarity. */
function centroidOf(vectors: number[][]): number[] {
  const validVecs = vectors.filter((v) => v && v.length > 0);
  if (validVecs.length === 0) return [];
  const dim = validVecs[0].length;
  const sum = new Float64Array(dim);
  for (const v of validVecs) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  for (let i = 0; i < dim; i++) sum[i] /= validVecs.length;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += sum[i] * sum[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return [];
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) out[i] = sum[i] / norm;
  return out;
}

export interface QualityGateResult {
  /** The (possibly category-pruned) candidates. */
  candidates: CategoryCandidates;
  /** Per-category diagnostic — what each top match scored and whether
   *  it was dropped. Surfaced via logs so we can tune the threshold
   *  empirically. */
  scores: Array<{
    category: ClothingCategory;
    topCosine: number;
    dropped:   boolean;
    topId:     string | null;
  }>;
}

/**
 * Drop categories whose top match is below `threshold` cosine similarity
 * to the user's query centroid (mean of pin embeddings).
 *
 * `queryEmbeddings` should be the *post-pipeline* embeddings — what
 * actually got passed to hybridSearch — so the gate scores against the
 * same centroid the retrieval used. Don't pass raw pre-blend pin vectors;
 * those would gate on a centroid that diverges from what was searched
 * and produce inconsistent results.
 */
export async function applyCategoryQualityGate(
  candidates:      CategoryCandidates,
  queryEmbeddings: number[][],
  threshold:       number = DEFAULT_THRESHOLD,
): Promise<QualityGateResult> {
  if (queryEmbeddings.length === 0) {
    return { candidates, scores: [] };
  }
  const centroid = centroidOf(queryEmbeddings);
  if (centroid.length === 0) {
    return { candidates, scores: [] };
  }

  // Collect top product IDs per category. A category with zero results
  // is already empty; nothing to gate.
  const topPerCategory: Array<{ category: ClothingCategory; id: string }> = [];
  for (const cat of CATEGORIES) {
    const top = candidates[cat]?.[0];
    if (top?.objectID) topPerCategory.push({ category: cat, id: top.objectID });
  }
  if (topPerCategory.length === 0) {
    return { candidates, scores: [] };
  }

  // Fetch visual vectors for the top products — ONE Pinecone batch call
  // covers all 6 categories. ~50–80 ms total. We don't need vibe vectors
  // for the gate — visual is what determined retrieval order, so it's
  // the right axis to gate on.
  let vectorMap: Map<string, number[] | null>;
  try {
    const fetched = await fetchVisualAndVibeVectors(topPerCategory.map((t) => t.id));
    vectorMap = new Map(fetched.map((r) => [r.id, r.visual]));
  } catch (err) {
    console.warn("[quality-gate] vector fetch failed; passing all candidates through:",
      err instanceof Error ? err.message : err);
    return { candidates, scores: [] };
  }

  // Score and gate. Mutate a shallow copy so callers get a fresh
  // CategoryCandidates and we don't poison anything upstream.
  const out: CategoryCandidates = { ...candidates };
  const scores: QualityGateResult["scores"] = [];

  for (const { category, id } of topPerCategory) {
    const vec = vectorMap.get(id);
    if (!vec || vec.length === 0) {
      // Vector missing — can't score, leave the category alone.
      scores.push({ category, topCosine: NaN, dropped: false, topId: id });
      continue;
    }
    const topCosine = cosineSimilarity(centroid, vec);
    const dropped   = topCosine < threshold;
    if (dropped) {
      out[category] = [];
    }
    scores.push({ category, topCosine, dropped, topId: id });
  }

  return { candidates: out, scores };
}
