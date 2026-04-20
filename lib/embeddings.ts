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

import type { ProductMetadata, StyleAxes, VisionImage } from "@/lib/types";
import { applyTasteHeadBatch, tasteHeadAvailable } from "@/lib/taste-head";

// ── Model ID ──────────────────────────────────────────────────────────────────
// Must match the model used in scripts/embed-with-qc.mjs exactly.
const MODEL_ID = "ff13/fashion-clip";

// Pinecone namespace holding the parallel "vibe vector" — FashionCLIP-text-
// encoded Claude caption, one per product. Written by scripts/enrich-product.mjs.
const VIBE_NAMESPACE  = "vibe";

// Pinecone namespace holding product vectors projected through the trained
// taste head. Populated by scripts/apply-taste-head.mjs once the projection
// head has been trained on curation-log.jsonl data.
const TASTE_NAMESPACE = "taste";

// ── Axis filter → Pinecone filter ─────────────────────────────────────────────
// A partial constraint set on the five style axes. Numbers are interpreted as
// lower bounds by default, but a tuple [min, max] specifies a range. Missing
// keys are unconstrained.
export type AxisFilter = Partial<Record<keyof StyleAxes, number | [number, number]>>;

export function buildAxisFilter(axes: AxisFilter | undefined): Record<string, unknown> | null {
  if (!axes) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(axes)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      const [lo, hi] = v;
      out[k] = { $gte: lo, $lte: hi };
    } else {
      out[k] = { $gte: v };
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** Merge price + axis filters into a single Pinecone filter object. */
function mergeFilters(
  priceRange: string | undefined,
  axes:       AxisFilter | undefined,
): Record<string, unknown> | null {
  const parts: Record<string, unknown>[] = [];
  const price = buildPriceFilter(priceRange);
  const axis  = buildAxisFilter(axes);
  if (price) parts.push(price);
  if (axis)  parts.push(axis);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}

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

/**
 * Subtract the centroid of negative examples from a positive vector.
 * Pushes the query *away* from the avoid set in the shared CLIP space.
 *
 * Weight is intentionally low (0.25 default) — too high and the resulting
 * vector flips direction entirely, returning bizarre results.
 */
export function subtractCentroid(
  positive: number[],
  negatives: number[][],
  weight = 0.25,
): number[] {
  if (negatives.length === 0 || positive.length === 0) return positive;
  const negMean = normalize(meanVector(negatives));
  if (negMean.length === 0) return positive;
  return normalize(positive.map((v, i) => v - weight * (negMean[i] ?? 0)));
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

// ── Warmup ────────────────────────────────────────────────────────────────────
/**
 * Kick off the FashionCLIP vision + text model downloads without waiting. Idempotent
 * — subsequent calls are cheap no-ops because `getVisionModel` / `getTextModel`
 * cache their initialisation promises at module scope.
 *
 * Use case: on a cold Lambda, model download + ONNX init is ~10–30 s. The
 * /api/shop handler's first action is a Claude Haiku call that doesn't need
 * the models; calling `warmupEmbeddingModels()` at the top of the handler
 * overlaps the model fetch with Claude's round trip so the `embed…` calls
 * further down the pipeline find the models already loaded.
 *
 * Errors are swallowed — the normal `getVisionModel`/`getTextModel` paths
 * will retry when an embedding is actually requested.
 */
export function warmupEmbeddingModels(): void {
  void getVisionModel().catch(() => {});
  void getTextModel().catch(()   => {});
}

// Fire once at module load so the cold-start download happens during Next.js
// module initialisation rather than blocking the first request that actually
// needs an embedding. No-op on warm Lambdas because the singletons are
// already hydrated.
warmupEmbeddingModels();

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

export interface SearchOptions {
  priceRange?: string;
  /** Lower-bound (or range) constraints on style axes — e.g. {minimalism: 0.6}. */
  axes?:       AxisFilter;
  /** Pinecone namespace. Default = "" (visual); "vibe" = caption-based vectors. */
  namespace?:  string;
}

export async function searchByEmbeddings(
  embeddings: number[][],
  totalK      = 120,
  options:    SearchOptions = {},
): Promise<string[]> {
  const valid = embeddings.filter((e) => e.length > 0);
  if (valid.length === 0) return [];

  const clusters       = clusterEmbeddings(valid, 0.78);
  const pineconeFilter = mergeFilters(options.priceRange, options.axes);
  const seen           = new Map<string, number>();
  const idx            = await getPineconeIndex();
  const target         = options.namespace ? idx.namespace(options.namespace) : idx;

  await Promise.all(
    clusters.map(async (cluster) => {
      const k = Math.max(10, Math.round(totalK * cluster.weight));
      const result = await target.query({
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

// ── Vibe-namespace search ─────────────────────────────────────────────────────
// Encodes one or more Claude-caption-style query phrases and searches the
// `vibe` namespace, which stores FashionCLIP-text-encoded product captions.
// Complements visual search: vibe hits on "how it reads" (quiet luxury, edgy,
// romantic) while visual hits on pixel similarity.

export async function searchByVibeEmbeddings(
  embeddings: number[][],
  totalK      = 120,
  options:    Omit<SearchOptions, "namespace"> = {},
): Promise<string[]> {
  return searchByEmbeddings(embeddings, totalK, { ...options, namespace: VIBE_NAMESPACE });
}

export async function searchByVibeText(
  phrases:    string[],
  totalK      = 120,
  options:    Omit<SearchOptions, "namespace"> = {},
): Promise<string[]> {
  const vectors = await Promise.all(phrases.map((p) => embedTextQuery(p).catch(() => [] as number[])));
  const valid   = vectors.filter((v) => v.length > 0);
  if (valid.length === 0) return [];
  return searchByVibeEmbeddings(valid, totalK, options);
}

// ── Taste-namespace search ────────────────────────────────────────────────────
// Applies the trained taste projection W to the query vector(s) and searches
// the `taste` Pinecone namespace, which holds product vectors pre-projected
// through the same W. Returns [] when no taste head is trained so callers can
// gracefully skip this ranker in the hybrid fusion.

export async function searchByTasteEmbeddings(
  embeddings: number[][],
  totalK      = 120,
  options:    Omit<SearchOptions, "namespace"> = {},
): Promise<string[]> {
  if (!(await tasteHeadAvailable())) return [];
  const projected = await applyTasteHeadBatch(embeddings.filter((e) => e.length > 0));
  if (projected.length === 0) return [];
  return searchByEmbeddings(projected, totalK, { ...options, namespace: TASTE_NAMESPACE });
}

// ── Fetch pre-computed product metadata (attrs + axes + caption) ──────────────

export async function fetchProductMetadata(ids: string[]): Promise<Map<string, ProductMetadata>> {
  const out = new Map<string, ProductMetadata>();
  if (ids.length === 0) return out;
  const idx     = await getPineconeIndex();
  const fetched = await idx.fetch({ ids });
  for (const [id, rec] of Object.entries(fetched.records ?? {})) {
    const md = (rec as { metadata?: ProductMetadata }).metadata;
    if (md) out.set(id, md);
  }
  return out;
}

// ── Text → Pinecone search ────────────────────────────────────────────────────
// Encodes a text query and searches the visual index directly.
// Useful for text-mode hybrid search when you want semantic image retrieval.

export async function searchByTextQuery(
  text:       string,
  totalK      = 120,
  options:    SearchOptions = {},
): Promise<string[]> {
  const embedding = await embedTextQuery(text);
  if (embedding.length === 0) return [];
  return searchByEmbeddings([embedding], totalK, options);
}

// ── Search by board image URLs ────────────────────────────────────────────────

export async function searchByBoardImages(
  boardImageUrls: string[],
  totalK          = 120,
  options:        SearchOptions = {},
): Promise<string[]> {
  if (!boardImageUrls.length) return [];
  const embeddings = await embedImageUrls(boardImageUrls);
  return searchByEmbeddings(embeddings, totalK, options);
}

// ── Search by uploaded base64 images ─────────────────────────────────────────

export async function searchByUploadedImages(
  images:     VisionImage[],
  totalK      = 120,
  options:    SearchOptions = {},
): Promise<string[]> {
  if (!images.length) return [];
  const embeddings = await embedBase64Images(images);
  return searchByEmbeddings(embeddings, totalK, options);
}

// ── Search using liked product embeddings ─────────────────────────────────────

export async function searchByLikedProductIds(
  objectIDs:  string[],
  totalK      = 60,
  options:    SearchOptions = {},
  excludeIds?: string[]
): Promise<string[]> {
  if (objectIDs.length === 0) return [];

  const index   = await getPineconeIndex();
  const fetched = await index.fetch({ ids: objectIDs });
  const vectors = (Object.values(fetched.records ?? {}) as Array<{ values?: number[] }>)
    .map((r) => Array.from(r.values ?? []))
    .filter((v) => v.length > 0);

  if (vectors.length === 0) return [];

  const ids = await searchByEmbeddings(vectors, totalK + (excludeIds?.length ?? 0), options);

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
