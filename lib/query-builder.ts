/**
 * Build a rich set of FashionCLIP query vectors from a StyleDNA.
 *
 * Three improvements over a single-vector query:
 *   1. Multi-vector — encode each per-category phrase from the StyleDNA as
 *      its own vector. The Pinecone search clusters these and pulls a
 *      richer, category-balanced candidate set.
 *   2. Negative subtraction — encode `avoids` as text, take their centroid,
 *      and subtract from each positive vector. Pushes results away from the
 *      wrong vibe in the shared image-text space.
 *   3. Aesthetic anchor — for image-driven modes (Pinterest / uploads),
 *      encode the StyleDNA as a single text vector and blend at low weight
 *      into each image vector so visual results stay aligned with intent.
 *
 * All operations live in CLIP's shared space — no extra dependencies.
 */

import { embedTextQuery, blendCentroids, subtractCentroid } from "@/lib/embeddings";
import type { StyleDNA } from "@/lib/types";

// Lower weight = subtle nudge; higher = aggressive steer.
const NEGATIVE_WEIGHT       = 0.25;  // how hard to push away from `avoids`
const AESTHETIC_ANCHOR_WT   = 0.50;  // how much StyleDNA text steers image vectors (Pinterest/uploads)
const MAX_AVOIDS_TO_ENCODE  = 5;
const MAX_PHRASES_PER_CAT   = 2;

/** A short FashionCLIP-friendly phrase summarizing the overall vibe. */
function aestheticPhrase(dna: StyleDNA): string {
  const parts = [
    dna.primary_aesthetic,
    dna.secondary_aesthetic,
    dna.mood,
    ...(dna.color_palette ?? []).slice(0, 3),
    ...(dna.silhouettes  ?? []).slice(0, 2),
    ...(dna.style_keywords ?? []).slice(0, 4),
  ].filter((s): s is string => Boolean(s && s.trim()));
  return parts.join(", ");
}

/** Collect every per-category phrase Claude generated. */
function collectCategoryPhrases(dna: StyleDNA): string[] {
  const cats = ["dress", "top", "bottom", "jacket", "shoes", "bag"] as const;
  const phrases: string[] = [];
  for (const cat of cats) {
    const list = dna.category_queries?.[cat] ?? [];
    for (const q of list.slice(0, MAX_PHRASES_PER_CAT)) {
      if (q?.trim()) phrases.push(q.trim());
    }
  }
  return phrases;
}

/**
 * Build an ensemble of text query vectors for a StyleDNA, with negative
 * subtraction applied to each. Used for text/quiz mode.
 */
export async function buildTextQueryVectors(
  dna:        StyleDNA,
  softAvoids: string[] = [],
): Promise<number[][]> {
  // Collect positive phrases: per-category specifics + one overall summary
  const phrases = collectCategoryPhrases(dna);
  phrases.push(aestheticPhrase(dna));

  // Encode all positives in parallel
  const positives = await Promise.all(
    phrases.map((p) => embedTextQuery(p).catch(() => [] as number[])),
  );
  const validPositives = positives.filter((v) => v.length > 0);
  if (validPositives.length === 0) return [];

  // Encode the avoids → single negative centroid
  const allAvoids = [...(dna.avoids ?? []), ...softAvoids]
    .filter((a): a is string => Boolean(a?.trim()))
    .slice(0, MAX_AVOIDS_TO_ENCODE);

  let negatives: number[][] = [];
  if (allAvoids.length > 0) {
    const negVecs = await Promise.all(
      allAvoids.map((a) => embedTextQuery(a).catch(() => [] as number[])),
    );
    negatives = negVecs.filter((v) => v.length > 0);
  }

  // Apply negative subtraction to each positive vector
  if (negatives.length === 0) return validPositives;
  return validPositives.map((v) => subtractCentroid(v, negatives, NEGATIVE_WEIGHT));
}

/**
 * Pinterest / uploads mode: blend a small amount of the StyleDNA's
 * text-encoded "anchor" into each image vector so the visual search stays
 * aligned with the inferred intent. Defaults to 10% weight — subtle.
 *
 * Avoids are also subtracted from each anchored vector at low weight.
 */
export async function anchorImageVectorsWithAesthetic(
  imageVectors: number[][],
  dna:          StyleDNA,
  softAvoids:   string[] = [],
  anchorWeight  = AESTHETIC_ANCHOR_WT,
): Promise<number[][]> {
  if (imageVectors.length === 0) return imageVectors;

  // Encode StyleDNA as a single text anchor
  const anchor = await embedTextQuery(aestheticPhrase(dna)).catch(() => [] as number[]);
  if (anchor.length === 0) return imageVectors;

  // Optionally encode avoids for pushback
  const allAvoids = [...(dna.avoids ?? []), ...softAvoids]
    .filter((a): a is string => Boolean(a?.trim()))
    .slice(0, MAX_AVOIDS_TO_ENCODE);

  let negatives: number[][] = [];
  if (allAvoids.length > 0) {
    const negVecs = await Promise.all(
      allAvoids.map((a) => embedTextQuery(a).catch(() => [] as number[])),
    );
    negatives = negVecs.filter((v) => v.length > 0);
  }

  return imageVectors
    .filter((v) => v.length > 0)
    .map((imgVec) => {
      const anchored = blendCentroids(imgVec, [anchor], anchorWeight);
      return negatives.length > 0
        ? subtractCentroid(anchored, negatives, NEGATIVE_WEIGHT * 0.5) // even gentler for images
        : anchored;
    });
}
