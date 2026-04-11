/**
 * Visual embedding retrieval — board images → CLIP embeddings →
 * weighted cluster queries against Pinecone → ranked product objectIDs.
 *
 * No paid APIs needed. Uses:
 *   @xenova/transformers  — free, runs locally in Node (no API key)
 *   @pinecone-database/pinecone — free tier, 100K vectors, no credit card
 *
 * Env vars required:
 *   PINECONE_API_KEY   — from pinecone.io (free account)
 *   PINECONE_INDEX     — e.g. "muse"
 */

import type { VisionImage } from "@/lib/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Cluster {
  centroid: number[];
  weight:   number;   // fraction of board pins in this cluster
  size:     number;
}

// ── Pure math ─────────────────────────────────────────────────────────────────

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = norm(a) * norm(b);
  return n === 0 ? 0 : dot(a, b) / n;
}

function normalize(v: number[]): number[] {
  const n = norm(v);
  return n === 0 ? v : v.map((x) => x / n);
}

function meanVector(vecs: number[][]): number[] {
  if (vecs.length === 0) return [];
  const out = new Array<number>(vecs[0].length).fill(0);
  for (const v of vecs) for (let i = 0; i < v.length; i++) out[i] += v[i];
  return out.map((x) => x / vecs.length);
}

// ── Clustering ────────────────────────────────────────────────────────────────

export function clusterEmbeddings(
  embeddings: number[][],
  threshold = 0.78
): Cluster[] {
  if (embeddings.length === 0) return [];
  if (embeddings.length === 1) return [{ centroid: embeddings[0], weight: 1, size: 1 }];

  const clusters: { members: number[][]; centroid: number[] }[] = [];

  for (const emb of embeddings) {
    let bestIdx = -1;
    let bestSim = threshold;

    for (let i = 0; i < clusters.length; i++) {
      const sim = cosineSimilarity(emb, clusters[i].centroid);
      if (sim > bestSim) { bestSim = sim; bestIdx = i; }
    }

    if (bestIdx === -1) {
      clusters.push({ members: [emb], centroid: normalize(emb) });
    } else {
      clusters[bestIdx].members.push(emb);
      clusters[bestIdx].centroid = normalize(meanVector(clusters[bestIdx].members));
    }
  }

  const total = embeddings.length;
  return clusters
    .sort((a, b) => b.members.length - a.members.length)
    .map((c) => ({ centroid: c.centroid, weight: c.members.length / total, size: c.members.length }));
}

// ── Centroid blending (session feedback loop) ─────────────────────────────────
// Nudges a query centroid toward the average of liked product embeddings.
// weight=0.3 → liked products shift the query by 30%.

export function blendCentroids(
  original: number[],
  liked:    number[][],
  weight = 0.3
): number[] {
  if (liked.length === 0 || original.length === 0) return original;
  const likedMean = normalize(meanVector(liked));
  if (likedMean.length === 0) return original;
  return normalize(original.map((v, i) => (1 - weight) * v + weight * (likedMean[i] ?? 0)));
}

// ── Model loading (server-side singleton) ─────────────────────────────────────

let _processorPromise: Promise<unknown> | null = null;
let _modelPromise:     Promise<unknown> | null = null;

async function getModel(): Promise<{ processor: unknown; model: unknown } | null> {
  try {
    const { env, CLIPVisionModelWithProjection, AutoProcessor } = await import(
      "@xenova/transformers"
    );

    const MODEL_ID = "Xenova/clip-vit-base-patch32";
    env.allowLocalModels = false;

    if (!_processorPromise) _processorPromise = AutoProcessor.from_pretrained(MODEL_ID);
    if (!_modelPromise)
      _modelPromise = CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
        quantized: true,
      });

    const [processor, model] = await Promise.all([_processorPromise, _modelPromise]);
    return { processor, model };
  } catch {
    // @xenova/transformers not available in this environment (e.g. Vercel build)
    // Visual search will fall back to Algolia text search in the calling route.
    return null;
  }
}

// ── Embed image URLs ──────────────────────────────────────────────────────────

export async function embedImageUrls(urls: string[]): Promise<number[][]> {
  const modelData = await getModel();
  if (!modelData) return [];

  const { RawImage } = await import("@xenova/transformers").catch(() => ({ RawImage: null }));
  if (!RawImage) return [];

  const { processor, model } = modelData;
  const results: number[][] = [];

  for (const url of urls) {
    try {
      const image = await (RawImage as { fromURL: (url: string) => Promise<unknown> }).fromURL(url);
      // @ts-expect-error — dynamic model call
      const inputs = await processor(image);
      // @ts-expect-error — dynamic model call
      const { image_embeds } = await model(inputs);
      results.push(Array.from(image_embeds.data as Float32Array));
    } catch {
      results.push([]);
    }
  }

  return results;
}

// ── Embed base64 images (for user-uploaded files) ─────────────────────────────

export async function embedBase64Images(images: VisionImage[]): Promise<number[][]> {
  const modelData = await getModel();
  if (!modelData) return [];

  const { RawImage } = await import("@xenova/transformers").catch(() => ({ RawImage: null }));
  if (!RawImage) return [];

  const { processor, model } = modelData;
  const results: number[][] = [];

  for (const img of images) {
    try {
      const buffer = Buffer.from(img.base64, "base64");
      const blob   = new Blob([buffer], { type: img.mimeType });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const image  = await (RawImage as any).fromBlob(blob);
      // @ts-expect-error — dynamic model call
      const inputs = await processor(image);
      // @ts-expect-error — dynamic model call
      const { image_embeds } = await model(inputs);
      results.push(Array.from(image_embeds.data as Float32Array));
    } catch {
      results.push([]);
    }
  }

  return results;
}

// ── Pinecone client (singleton) ───────────────────────────────────────────────
// Dynamic import so webpack never statically resolves @pinecone-database/pinecone
// (avoids "Module not found" in Vercel builds where the package is runtime-only).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pinecone: any = null;

async function getPinecone() {
  if (!_pinecone) {
    const { Pinecone } = await import("@pinecone-database/pinecone");
    _pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  }
  return _pinecone;
}

export async function getPineconeIndex() {
  const pc = await getPinecone();
  return pc.index(process.env.PINECONE_INDEX ?? "muse");
}

// ── Core search by pre-computed embeddings ────────────────────────────────────
// Accepts any set of embeddings — URL-fetched, base64-embedded, or text-encoded.
// Clusters them, allocates search budget by cluster size, merges results.

export async function searchByEmbeddings(
  embeddings: number[][],
  totalK      = 120,
  priceRange?: string
): Promise<string[]> {
  const valid = embeddings.filter((e) => e.length > 0);
  if (valid.length === 0) return [];

  const clusters      = clusterEmbeddings(valid, 0.78);
  const pineconeFilter = buildPriceFilter(priceRange);
  const seen           = new Map<string, number>();
  const index          = await getPineconeIndex();

  await Promise.all(
    clusters.map(async (cluster) => {
      const k = Math.max(10, Math.round(totalK * cluster.weight));
      const result = await index.query({
        vector:          cluster.centroid,
        topK:            k,
        includeMetadata: false,
        ...(pineconeFilter ? { filter: pineconeFilter } : {}),
      });

      for (const match of result.matches ?? []) {
        const score = (match.score ?? 0) * cluster.weight;
        seen.set(match.id, (seen.get(match.id) ?? 0) + score);
      }
    })
  );

  return Array.from(seen.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, totalK);
}

// ── Search by board image URLs (Pinterest / original flow) ───────────────────

export async function searchByBoardImages(
  boardImageUrls: string[],
  totalK          = 120,
  priceRange?:    string
): Promise<string[]> {
  if (!boardImageUrls.length) return [];
  const embeddings = await embedImageUrls(boardImageUrls);
  return searchByEmbeddings(embeddings, totalK, priceRange);
}

// ── Search by uploaded base64 images ─────────────────────────────────────────

export async function searchByUploadedImages(
  images:     VisionImage[],
  totalK      = 120,
  priceRange?: string
): Promise<string[]> {
  if (!images.length) return [];
  const embeddings = await embedBase64Images(images);
  return searchByEmbeddings(embeddings, totalK, priceRange);
}

// ── Search using liked product embeddings (for session feedback / refine) ─────
// Fetches the stored CLIP vectors of liked products from Pinecone,
// uses their average + clustering as the new query centroid.

export async function searchByLikedProductIds(
  objectIDs:  string[],
  totalK      = 60,
  priceRange?: string,
  excludeIds?: string[]
): Promise<string[]> {
  if (objectIDs.length === 0) return [];

  const index   = await getPineconeIndex();
  const fetched = await index.fetch({ ids: objectIDs });
  const vectors = (Object.values(fetched.records ?? {}) as Array<{ values?: number[] }>)
    .map((r) => Array.from(r.values ?? []))
    .filter((v) => v.length > 0);

  if (vectors.length === 0) return [];

  const ids = await searchByEmbeddings(vectors, totalK + (excludeIds?.length ?? 0), priceRange);

  // Exclude products already shown
  const excluded = new Set(excludeIds ?? []);
  return ids.filter((id) => !excluded.has(id)).slice(0, totalK);
}

// ── Price filter helper ───────────────────────────────────────────────────────

function buildPriceFilter(priceRange?: string): Record<string, unknown> | null {
  if (!priceRange) return null;
  if (priceRange === "budget")  return { price_range: { $in: ["budget"] } };
  if (priceRange === "luxury")  return { price_range: { $in: ["luxury", "mid"] } };
  return { price_range: { $in: ["mid", "budget"] } };
}
