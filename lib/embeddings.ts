/**
 * Visual + text embedding retrieval via FashionCLIP → Pinecone vector search.
 *
 * Uses ff13/fashion-clip — an ONNX-converted version of patrickjohncyh/fashion-clip,
 * fine-tuned on ~700K fashion image-text pairs. Produces 512-dim embeddings
 * in the same joint image-text space as standard CLIP, but with much better
 * understanding of fashion concepts (silhouettes, fabrics, styles, cuts).
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

// ── Model ID ──────────────────────────────────────────────────────────────────
// Must match the model used in scripts/embed-with-qc.mjs exactly.
const MODEL_ID = "ff13/fashion-clip";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Cluster {
  centroid: number[];
  weight:   number;
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

// ── Vision model singleton ─────────────────────────────────────────────────────

let _visionProcessorPromise: Promise<unknown> | null = null;
let _visionModelPromise:     Promise<unknown> | null = null;

async function getVisionModel(): Promise<{ processor: unknown; model: unknown } | null> {
  try {
    const { env, CLIPVisionModelWithProjection, AutoProcessor } = await import(
      /* webpackIgnore: true */ "@xenova/transformers"
    );
    env.allowLocalModels = false;
    env.cacheDir = "./.cache/transformers";

    if (!_visionProcessorPromise) _visionProcessorPromise = AutoProcessor.from_pretrained(MODEL_ID);
    if (!_visionModelPromise)
      _visionModelPromise = CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { quantized: true });

    const [processor, model] = await Promise.all([_visionProcessorPromise, _visionModelPromise]);
    return { processor, model };
  } catch {
    return null;
  }
}

// ── Text model singleton ───────────────────────────────────────────────────────

let _textTokenizerPromise: Promise<unknown> | null = null;
let _textModelPromise:     Promise<unknown> | null = null;

async function getTextModel(): Promise<{ tokenizer: unknown; model: unknown } | null> {
  try {
    const { env, CLIPTextModelWithProjection, AutoTokenizer } = await import(
      /* webpackIgnore: true */ "@xenova/transformers"
    );
    env.allowLocalModels = false;
    env.cacheDir = "./.cache/transformers";

    if (!_textTokenizerPromise) _textTokenizerPromise = AutoTokenizer.from_pretrained(MODEL_ID);
    if (!_textModelPromise)
      _textModelPromise = CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { quantized: true });

    const [tokenizer, model] = await Promise.all([_textTokenizerPromise, _textModelPromise]);
    return { tokenizer, model };
  } catch {
    return null;
  }
}

// ── Embed image URLs ──────────────────────────────────────────────────────────

export async function embedImageUrls(urls: string[]): Promise<number[][]> {
  const modelData = await getVisionModel();
  if (!modelData) return [];

  const { RawImage } = await import(/* webpackIgnore: true */ "@xenova/transformers")
    .catch(() => ({ RawImage: null }));
  if (!RawImage) return [];

  const { processor, model } = modelData;
  const results: number[][] = [];

  for (const url of urls) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const image = await (RawImage as any).fromURL(url);
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

// ── Embed base64 images (user uploads) ────────────────────────────────────────

export async function embedBase64Images(images: VisionImage[]): Promise<number[][]> {
  const modelData = await getVisionModel();
  if (!modelData) return [];

  const { RawImage } = await import(/* webpackIgnore: true */ "@xenova/transformers")
    .catch(() => ({ RawImage: null }));
  if (!RawImage) return [];

  const { processor, model } = modelData;
  const results: number[][] = [];

  for (const img of images) {
    try {
      const buffer = Buffer.from(img.base64, "base64");
      const blob   = new Blob([buffer], { type: img.mimeType });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const image = await (RawImage as any).fromBlob(blob);
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

// ── Embed a text query (for text → Pinecone visual search) ────────────────────
// Encodes a fashion text query into the same 512-dim space as the image vectors,
// enabling direct text-to-image search against the Pinecone index.

export async function embedTextQuery(text: string): Promise<number[]> {
  const modelData = await getTextModel();
  if (!modelData) return [];

  const { tokenizer, model } = modelData;

  try {
    // @ts-expect-error — dynamic model call
    const inputs = await tokenizer(text, { padding: true, truncation: true });
    // @ts-expect-error — dynamic model call
    const { text_embeds } = await model(inputs);
    return Array.from(text_embeds.data as Float32Array);
  } catch {
    return [];
  }
}

// ── Pinecone client (singleton) ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pinecone: any = null;

async function getPinecone() {
  if (!_pinecone) {
    const { Pinecone } = await import(/* webpackIgnore: true */ "@pinecone-database/pinecone");
    _pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  }
  return _pinecone;
}

export async function getPineconeIndex() {
  const pc = await getPinecone();
  return pc.index(process.env.PINECONE_INDEX ?? "muse");
}

// ── Core search by pre-computed embeddings ────────────────────────────────────

export async function searchByEmbeddings(
  embeddings: number[][],
  totalK      = 120,
  priceRange?: string
): Promise<string[]> {
  const valid = embeddings.filter((e) => e.length > 0);
  if (valid.length === 0) return [];

  const clusters       = clusterEmbeddings(valid, 0.78);
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

// ── Text → Pinecone search ────────────────────────────────────────────────────
// Encodes a text query and searches the visual index directly.
// Useful for text-mode hybrid search when you want semantic image retrieval.

export async function searchByTextQuery(
  text:       string,
  totalK      = 120,
  priceRange?: string
): Promise<string[]> {
  const embedding = await embedTextQuery(text);
  if (embedding.length === 0) return [];
  return searchByEmbeddings([embedding], totalK, priceRange);
}

// ── Search by board image URLs ────────────────────────────────────────────────

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

// ── Search using liked product embeddings ─────────────────────────────────────

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
