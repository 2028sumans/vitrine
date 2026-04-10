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
 *   PINECONE_INDEX     — e.g. "vitrine-products"
 */

import { Pinecone } from "@pinecone-database/pinecone";

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
// Greedy single-pass: assign each embedding to the nearest existing centroid
// (if similarity > threshold), otherwise start a new cluster.
// Repetition = size of cluster = weight = more search budget.

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

// ── Model loading (server-side singleton) ─────────────────────────────────────
// The CLIP vision encoder loads once per Lambda warm instance (~200ms after
// first cold-start download). Downloaded to /tmp and cached automatically.

let _processorPromise: Promise<unknown> | null = null;
let _modelPromise: Promise<unknown> | null = null;

async function getModel() {
  // Lazy-import so this module can be tree-shaken in browser builds
  const { env, CLIPVisionModelWithProjection, AutoProcessor } = await import(
        "@xenova/transformers"
  );

  const MODEL_ID = "Xenova/clip-vit-base-patch32";
  env.allowLocalModels = false; // always pull from HuggingFace Hub

  if (!_processorPromise) _processorPromise = AutoProcessor.from_pretrained(MODEL_ID);
  if (!_modelPromise)
    _modelPromise = CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
      quantized: true, // ~80MB vs ~340MB; quality difference is negligible for retrieval
    });

  const [processor, model] = await Promise.all([_processorPromise, _modelPromise]);
  return { processor, model };
}

// ── Embed image URLs ──────────────────────────────────────────────────────────

export async function embedImageUrls(urls: string[]): Promise<number[][]> {
  const { RawImage } = await import(
        "@xenova/transformers"
  );
  const { processor, model } = await getModel();

  const results: number[][] = [];

  for (const url of urls) {
    try {
      const image = await (RawImage as { fromURL: (url: string) => Promise<unknown> }).fromURL(url);
      // @ts-expect-error — dynamic model call
      const inputs = await processor(image);
      // @ts-expect-error — dynamic model call
      const { image_embeds } = await model(inputs);
      // image_embeds is already L2-normalized by CLIP — shape [1, 512]
      results.push(Array.from(image_embeds.data as Float32Array));
    } catch {
      // Skip images that fail to load (broken URL, network error, etc.)
      results.push([]);
    }
  }

  return results;
}

// ── Pinecone client (singleton) ───────────────────────────────────────────────

let _pinecone: Pinecone | null = null;

function getPinecone() {
  if (!_pinecone) _pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  return _pinecone;
}

function getPineconeIndex() {
  return getPinecone().index(process.env.PINECONE_INDEX ?? "vitrine-products");
}

// ── Main retrieval function ───────────────────────────────────────────────────
// 1. Embed board pin images
// 2. Cluster → weight clusters by size (repetition = preference signal)
// 3. Query Pinecone once per cluster, budget proportional to weight
// 4. Re-rank merged results by (similarity × cluster_weight)
// 5. Return ordered objectIDs

export async function searchByBoardImages(
  boardImageUrls: string[],
  totalK         = 120,
  priceRange?:   string   // "budget" | "mid" | "luxury" — optional Pinecone metadata filter
): Promise<string[]> {
  if (!boardImageUrls.length) return [];

  // 1. Embed
  const raw = await embedImageUrls(boardImageUrls);
  const embeddings = raw.filter((e) => e.length > 0);
  if (embeddings.length === 0) return [];

  // 2. Cluster (threshold 0.78 — boards are diverse so we want loose clusters)
  const clusters = clusterEmbeddings(embeddings, 0.78);

  // Build Pinecone price filter if provided
  const pineconeFilter = buildPriceFilter(priceRange);

  // 3. Query each cluster, budget = totalK × cluster.weight (min 10 per cluster)
  const seen    = new Map<string, number>(); // objectID → weighted score
  const index   = getPineconeIndex();

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

  // 4. Re-rank: products that appear in multiple cluster results get score summed
  return Array.from(seen.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, totalK);
}

function buildPriceFilter(priceRange?: string): Record<string, unknown> | null {
  if (!priceRange) return null;
  if (priceRange === "budget")  return { price_range: { $in: ["budget"] } };
  if (priceRange === "luxury")  return { price_range: { $in: ["luxury", "mid"] } };
  return { price_range: { $in: ["mid", "budget"] } };
}
