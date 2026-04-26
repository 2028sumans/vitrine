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

/** Merge price + axis + category filters into a single Pinecone filter object. */
function mergeFilters(
  priceRange: string | undefined,
  axes:       AxisFilter | undefined,
  categories: string[] | undefined = undefined,
): Record<string, unknown> | null {
  const parts: Record<string, unknown>[] = [];
  const price = buildPriceFilter(priceRange);
  const axis  = buildAxisFilter(axes);
  if (price) parts.push(price);
  if (axis)  parts.push(axis);
  if (categories && categories.length > 0) {
    parts.push({ category: { $in: categories } });
  }
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

// ── ONNX runtime configuration ────────────────────────────────────────────────
// @xenova/transformers v2 talks to ONNX Runtime through a `env.backends.onnx`
// config object. The defaults assume a browser with Cross-Origin Isolation
// (so SharedArrayBuffer / WASM threading works) — Vercel Lambdas don't have
// that, so the WASM threaded backend silently fails with "Can't create a
// session" during model load. Forcing single-threaded WASM (numThreads = 1)
// and disabling the worker-proxy path makes the load reliable on Vercel
// without changing anything for the local dev path (which has full COI).
//
// Set BEFORE the first `from_pretrained` call so the session-creation code
// reads the patched values. Idempotent — safe to call from both
// getVisionModel and getTextModel.
function configureOnnxRuntime(env: { backends?: { onnx?: { wasm?: { numThreads?: number; proxy?: boolean } } } }): void {
  const wasm = env?.backends?.onnx?.wasm;
  if (!wasm) return;
  wasm.numThreads = 1;
  wasm.proxy      = false;
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
    // Vercel's filesystem is read-only except for `/tmp`; local dev writes
    // alongside the repo for a warmer next-boot experience.
    env.cacheDir = process.env.VERCEL ? "/tmp/transformers" : "./.cache/transformers";
    configureOnnxRuntime(env);

    if (!_visionProcessorPromise) _visionProcessorPromise = AutoProcessor.from_pretrained(MODEL_ID);
    if (!_visionModelPromise)
      _visionModelPromise = CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { quantized: true });

    const [processor, model] = await Promise.all([_visionProcessorPromise, _visionModelPromise]);
    return { processor, model };
  } catch (err) {
    console.error("[embeddings] getVisionModel failed:", err);
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
    // Vercel's filesystem is read-only except for `/tmp`; local dev writes
    // alongside the repo for a warmer next-boot experience.
    env.cacheDir = process.env.VERCEL ? "/tmp/transformers" : "./.cache/transformers";
    configureOnnxRuntime(env);

    if (!_textTokenizerPromise) _textTokenizerPromise = AutoTokenizer.from_pretrained(MODEL_ID);
    if (!_textModelPromise)
      _textModelPromise = CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { quantized: true });

    const [tokenizer, model] = await Promise.all([_textTokenizerPromise, _textModelPromise]);
    return { tokenizer, model };
  } catch (err) {
    console.error("[embeddings] getTextModel failed:", err);
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
// Previously a serial for-loop: each image's (fetch → preprocess → inference)
// ran end-to-end before the next one started. For a 20-image Pinterest board
// that's ~20 × 100–150 ms = 2–3 s on the critical path.
//
// The network fetch (`RawImage.fromURL`) is the dominant cost per image and
// is trivially parallelizable. `Promise.all`-ing the per-item pipeline lets
// all fetches happen concurrently. ONNX runtime serializes the model calls
// internally on a single session, so inference still runs one at a time, but
// the fetch + preprocess waits overlap — empirically ~2–3× speedup on a 20-
// image board.

export async function embedImageUrls(urls: string[]): Promise<number[][]> {
  const modelData = await getVisionModel();
  if (!modelData) return [];

  const { RawImage } = await import(/* webpackIgnore: true */ "@xenova/transformers")
    .catch(() => ({ RawImage: null }));
  if (!RawImage) return [];

  const { processor, model } = modelData;

  return Promise.all(urls.map(async (url) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const image = await (RawImage as any).fromURL(url);
      // @ts-expect-error — dynamic model call
      const inputs = await processor(image);
      // @ts-expect-error — dynamic model call
      const { image_embeds } = await model(inputs);
      // L2-normalize to match how scripts/embed-with-qc.mjs stored these.
      // Pinecone's cosine metric handles non-unit, but downstream client-
      // side cosine (centroid blend, distinctness, taste-head projection)
      // assumes unit input. Normalize at the boundary so every consumer
      // gets a unit vector.
      return normalize(Array.from(image_embeds.data as Float32Array) as number[]);
    } catch (err) {
      console.error("[embeddings] embedImageUrls failed for", url, err);
      return [] as number[];
    }
  }));
}

// ── Embed base64 images (user uploads) ────────────────────────────────────────
// Same parallelization as `embedImageUrls`. Uploads have no network fetch, so
// the win here is smaller (just the preprocessing overlap) but non-zero.

export async function embedBase64Images(images: VisionImage[]): Promise<number[][]> {
  const modelData = await getVisionModel();
  if (!modelData) {
    console.error("[embeddings] embedBase64Images: getVisionModel returned null — model load failed (check earlier logs for the actual error from getVisionModel)");
    return images.map(() => [] as number[]);
  }

  const { RawImage } = await import(/* webpackIgnore: true */ "@xenova/transformers")
    .catch((err) => {
      console.error("[embeddings] embedBase64Images: failed to dynamic-import RawImage:", err instanceof Error ? err.message : err);
      return { RawImage: null };
    });
  if (!RawImage) return images.map(() => [] as number[]);

  const { processor, model } = modelData;

  return Promise.all(images.map(async (img, idx) => {
    try {
      const buffer = Buffer.from(img.base64, "base64");
      const blob   = new Blob([buffer], { type: img.mimeType });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const image = await (RawImage as any).fromBlob(blob);
      // @ts-expect-error — dynamic model call
      const inputs = await processor(image);
      // @ts-expect-error — dynamic model call
      const { image_embeds } = await model(inputs);
      // L2-normalize — see embedImageUrls comment for rationale.
      return normalize(Array.from(image_embeds.data as Float32Array) as number[]);
    } catch (err) {
      // Surface per-image failures — silent catches turn "model not on this
      // host" into "user gets cryptic error message." Each line includes the
      // image index, byte size, and mime type so we can correlate with the
      // upload payload when debugging from logs.
      console.error(
        `[embeddings] embedBase64Images: image[${idx}] failed (mime=${img.mimeType}, base64Bytes=${img.base64.length}):`,
        err instanceof Error ? `${err.name}: ${err.message}` : err,
      );
      return [] as number[];
    }
  }));
}

// ── Embed a text query (for text → Pinecone visual search) ────────────────────
// Encodes a fashion text query into the same 512-dim space as the image vectors,
// enabling direct text-to-image search against the Pinecone index.
//
// CLIP / FashionCLIP were trained on natural-sentence captions paired with
// images. Raw keyword salad ("dad-core chic") and abstract style words
// underperform on text→image search by ~5-15% recall vs. a templated prompt.
// Wrapping the query in `"a photo of …"` (the canonical CLIP zero-shot
// template) puts the text in the same distributional region as training
// captions and consistently improves nearest-neighbour quality.
//
// Caller can opt out by passing `template: "raw"` for queries that already
// include the prefix (e.g. retrieval_phrases produced by Claude in lib/ai.ts).

function applyTemplate(text: string, template: "auto" | "raw"): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return trimmed;
  if (template === "raw") return trimmed;
  // Already wrapped — don't double-prefix.
  if (/^a\s+(photo|picture|image)\s+of\b/i.test(trimmed)) return trimmed;
  return `a photo of ${trimmed}`;
}

export async function embedTextQuery(
  text:     string,
  template: "auto" | "raw" = "auto",
): Promise<number[]> {
  const modelData = await getTextModel();
  if (!modelData) return [];

  const { tokenizer, model } = modelData;

  try {
    // @ts-expect-error — dynamic model call
    const inputs = await tokenizer(applyTemplate(text, template), { padding: true, truncation: true });
    // @ts-expect-error — dynamic model call
    const { text_embeds } = await model(inputs);
    // L2-normalize. FashionCLIP's text projection head outputs raw
    // (non-unit) vectors — norms typically land 7–9. Stored Pinecone
    // vectors are unit (see scripts/embed-with-qc.mjs blendVectors).
    // Pinecone's cosine search is magnitude-invariant so the query
    // ranks correctly without this, but every client-side cosine in
    // the pipeline (centroid blend, distinctness, taste-head matrix
    // multiply) silently misbehaves on non-unit input. Normalize once
    // here and every downstream consumer is correct.
    return normalize(Array.from(text_embeds.data as Float32Array) as number[]);
  } catch {
    return [];
  }
}

// ── Pinecone client (singleton) ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pinecone: any = null;

// `webpackIgnore: true` was historically here to keep webpack from
// trying to bundle the package (it has dynamic requires that break).
// But the comment also hides the import from Vercel's file tracer, so
// the package wasn't getting deployed — every Pinecone search failed
// with "Cannot find package '@pinecone-database/pinecone'" at runtime.
// With `serverComponentsExternalPackages: ["@pinecone-database/pinecone"]`
// in next.config.js (added in 8115d60), webpack already keeps the import
// external — so we no longer need webpackIgnore. Vercel can trace and
// deploy the package normally.
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

export interface SearchOptions {
  priceRange?: string;
  /** Lower-bound (or range) constraints on style axes — e.g. {minimalism: 0.6}. */
  axes?:       AxisFilter;
  /** Pinecone namespace. Default = "" (visual); "vibe" = caption-based vectors. */
  namespace?:  string;
  /**
   * Restrict matches to one or more product categories — pushed down to
   * Pinecone as a metadata `$in` filter so the topK budget is spent inside
   * the requested bucket(s) instead of being dominated by whichever
   * category happens to be visually closest. Used by the per-category
   * FashionCLIP gate in lib/hybrid-search.twoStageStrictSearch.
   *
   * Note: this requires the product's `category` to be in its Pinecone
   * metadata. scripts/embed-with-qc.mjs writes it for every upsert, so
   * this is true for the production index.
   */
  categories?: string[];
  /**
   * Minimum per-match cosine similarity to accept. Default: 0 (accept all).
   * Set to 0.20-0.25 for "strict" semantic queries where off-aesthetic
   * neighbours should be dropped regardless of top-K ranking. FashionCLIP
   * cosine scores typically land 0.15-0.35 for real matches on this catalog;
   * below 0.18 the nearest neighbour is often off-aesthetic (pink dress for
   * a menswear query, bikini for a quiet-luxury query, etc.).
   *
   * Applied BEFORE the cluster-weight multiplier so the threshold is a real
   * similarity floor, not a weighted one.
   */
  minScore?:   number;
}

export async function searchByEmbeddings(
  embeddings: number[][],
  totalK      = 120,
  options:    SearchOptions = {},
): Promise<string[]> {
  const valid = embeddings.filter((e) => e.length > 0);
  if (valid.length === 0) return [];

  const clusters       = clusterEmbeddings(valid, 0.78);
  const pineconeFilter = mergeFilters(options.priceRange, options.axes, options.categories);
  const minScore       = options.minScore ?? 0;
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
        const rawScore = match.score ?? 0;
        // Strict threshold — drops off-aesthetic neighbours even when they
        // happen to be among the topK. When minScore is 0 (the historical
        // default) this is a no-op.
        if (rawScore < minScore) continue;
        const score = rawScore * cluster.weight;
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

/**
 * Fetch raw FashionCLIP vectors and structured metadata (StyleAxes +
 * StyleAttributes + brand/category/etc.) for a list of objectIDs.
 * Preserves input order — useful when the caller needs to apply a
 * recency-weighted decay across the result.
 *
 * Used by app/api/shop-all/route.ts to build the session centroid
 * (vectors → lib/taste-centroid) and the user's axis profile (metadata
 * → lib/taste-centroid.buildAxisProfile).
 */
export async function fetchProductsForCentroid(
  objectIDs: string[],
): Promise<Array<{ id: string; vector: number[] | null; metadata: Record<string, unknown> | null }>> {
  if (objectIDs.length === 0) return [];
  const index   = await getPineconeIndex();
  const fetched = await index.fetch({ ids: objectIDs });
  const records = fetched.records ?? {};
  return objectIDs.map((id) => {
    const r = records[id] as { values?: number[]; metadata?: Record<string, unknown> } | undefined;
    return {
      id,
      vector:   Array.isArray(r?.values) && r!.values.length > 0 ? Array.from(r!.values) : null,
      metadata: r?.metadata ?? null,
    };
  });
}

/**
 * Bulk-fetch visual + vibe vectors for a candidate id set. Used by the
 * 2-stage strict-mode retrieval (lib/hybrid-search.twoStageStrictSearch):
 * Algolia narrows the catalog by literal terms, and we fetch every
 * candidate's pair of vectors so we can score them locally with a
 * weighted cosine.
 *
 * Why local scoring instead of a Pinecone query? Pinecone's `query()`
 * returns its own topK with no way to constrain by id without metadata
 * filters (and our id-set can be larger than the 1000-element $in cap).
 * `fetch()` works directly with id batches and lets us combine visual
 * and vibe scores per item with arbitrary weights — exactly the shape
 * the 2-stage rerank needs.
 *
 * Returns one entry per input id, in the same order. Missing vectors
 * (id has no entry in either namespace) come back as null. Callers
 * decide how to handle them — the rerank just gives those candidates
 * a score of 0 and lets them lose to scored neighbours.
 */
export async function fetchVisualAndVibeVectors(
  objectIDs: string[],
): Promise<Array<{ id: string; visual: number[] | null; vibe: number[] | null }>> {
  if (objectIDs.length === 0) return [];

  const index = await getPineconeIndex();
  // Pinecone's fetch() caps at 1000 ids per call. Chunk and parallelise.
  const FETCH_CHUNK = 1000;
  const chunks: string[][] = [];
  for (let i = 0; i < objectIDs.length; i += FETCH_CHUNK) {
    chunks.push(objectIDs.slice(i, i + FETCH_CHUNK));
  }

  const visualNs = index;
  const vibeNs   = index.namespace(VIBE_NAMESPACE);

  // Hit both namespaces in parallel for each chunk pair, then flatten.
  const [visualRecords, vibeRecords] = await Promise.all([
    (async () => {
      const out: Record<string, { values?: number[] }> = {};
      for (const chunk of chunks) {
        try {
          const r = await visualNs.fetch({ ids: chunk });
          Object.assign(out, r.records ?? {});
        } catch (err) {
          console.warn("[embeddings] fetchVisualAndVibeVectors: visual fetch chunk failed:", err instanceof Error ? err.message : err);
        }
      }
      return out;
    })(),
    (async () => {
      const out: Record<string, { values?: number[] }> = {};
      for (const chunk of chunks) {
        try {
          const r = await vibeNs.fetch({ ids: chunk });
          Object.assign(out, r.records ?? {});
        } catch (err) {
          console.warn("[embeddings] fetchVisualAndVibeVectors: vibe fetch chunk failed:", err instanceof Error ? err.message : err);
        }
      }
      return out;
    })(),
  ]);

  return objectIDs.map((id) => ({
    id,
    visual: Array.isArray(visualRecords[id]?.values) && visualRecords[id]!.values!.length > 0
      ? Array.from(visualRecords[id]!.values!)
      : null,
    vibe:   Array.isArray(vibeRecords[id]?.values) && vibeRecords[id]!.values!.length > 0
      ? Array.from(vibeRecords[id]!.values!)
      : null,
  }));
}

/**
 * Single-vector Pinecone query that also returns metadata. Used for the
 * StyleAxes-aware ranking step where we need to score the result set's
 * axes against the user's profile.
 *
 * Returns ranked (id, score, metadata) tuples — caller does the rest.
 */
export async function searchByCentroidWithMetadata(
  centroid: number[],
  topK     = 200,
  options:  SearchOptions = {},
): Promise<Array<{ id: string; score: number; metadata: Record<string, unknown> }>> {
  if (!centroid || centroid.length === 0) return [];
  const index = await getPineconeIndex();
  const target = options.namespace ? index.namespace(options.namespace) : index;
  const filter = mergeFilters(options.priceRange, options.axes, options.categories);
  const result = await target.query({
    vector:          centroid,
    topK,
    includeMetadata: true,
    ...(filter ? { filter } : {}),
  });
  const minScore = options.minScore ?? 0;
  type PineconeMatch = { id: string; score?: number; metadata?: Record<string, unknown> };
  return ((result.matches ?? []) as PineconeMatch[])
    .filter((m: PineconeMatch) => (m.score ?? 0) >= minScore)
    .map((m: PineconeMatch) => ({
      id:       m.id,
      score:    m.score ?? 0,
      metadata: (m.metadata ?? {}) as Record<string, unknown>,
    }));
}

// ── Price filter helper ───────────────────────────────────────────────────────

function buildPriceFilter(priceRange?: string): Record<string, unknown> | null {
  if (!priceRange) return null;
  if (priceRange === "budget")  return { price_range: { $in: ["budget"] } };
  if (priceRange === "luxury")  return { price_range: { $in: ["luxury", "mid"] } };
  return { price_range: { $in: ["mid", "budget"] } };
}
