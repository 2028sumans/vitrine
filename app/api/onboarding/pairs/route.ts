/**
 * GET /api/onboarding/pairs
 *
 * Generate axis-contrastive product pairs for the onboarding "this or
 * this" gauntlet. Each pair contains two products from the same category
 * that sit on opposite ends of one of the five style axes (formality,
 * minimalism, edge, romance, drape). Asking the user to pick one tells us
 * which side of that axis they lean toward — and across ~50 positive picks
 * we can compute a personal taste centroid that's at least as informative
 * as the photo-upload alternative without any embed cost at save time
 * (vectors are already in Pinecone for every product in the catalog).
 *
 * Why we return 80 pairs not 50
 * ------------------------------
 * The UI offers a "neither" button per pair so users can skip pairs where
 * both options feel wrong. Without a buffer, a "neither"-heavy user could
 * exhaust 50 pairs with only 20 positive picks — too sparse for a useful
 * taste centroid. We over-generate: 80 pairs server-side, target = 50
 * positive picks client-side. Worst case the user hits "neither" 30+ times
 * and we save with what they have (saves ranking falls back to age + any
 * partial centroid the picks produced).
 *
 * Pair generation
 * ---------------
 *   1. Fetch one anchor vector (any product's 512-dim CLIP embedding) —
 *      Pinecone's `query` op requires a query vector, but our actual
 *      selection criterion is the metadata filter, not cosine similarity.
 *      The anchor is reused across every per-(category,axis) query so we
 *      pay one fetch.
 *   2. For each (category × axis) cell — 6 categories × 5 axes = 30 cells
 *      — query Pinecone twice: once with `{ category, [axis]: { $gte: 0.65 } }`
 *      to get high-axis candidates, once with `{ ..., $lte: 0.35 }` to get
 *      lows. topK = 16 each so we have variety to sample from.
 *   3. For each cell, build up to 3 random pairs (one high + one low,
 *      picked without replacement). 30 cells × ~2.7 pairs ≈ 80.
 *   4. Hydrate the picked IDs through Algolia getProductsByIds to get
 *      titles, images, prices, brands. Drop pairs where either side
 *      failed hydration (rare).
 *   5. Shuffle and slice to ~80, capped at MAX_PER_CAT per category to
 *      keep distribution even.
 *
 * Response
 * --------
 *   200 { pairs: Array<{ id, axis, category, a: Product, b: Product }>, count }
 *   500 { error: "..." } on Pinecone / Algolia failure
 *
 * Latency budget: ~60 Pinecone queries in parallel + 1 Algolia getObjects
 * with ~160 IDs = typically 1-2s cold, 300-500ms warm. The client shows a
 * "preparing your gauntlet" state during this fetch.
 */

import { NextResponse } from "next/server";
import { getPineconeIndex } from "@/lib/embeddings";
import { getProductsByIds } from "@/lib/algolia";
import type { AlgoliaProduct } from "@/lib/algolia";

export const runtime = "nodejs";
export const maxDuration = 30;

const CATEGORIES = ["top", "dress", "bottom", "jacket", "shoes", "bag"] as const;
const AXES       = ["formality", "minimalism", "edge", "romance", "drape"] as const;

const HIGH_THRESHOLD  = 0.65;
const LOW_THRESHOLD   = 0.35;
// Per (cat × axis) cell, how many candidates to sample from each end.
// Higher = more variety in pairs but more Pinecone topK.
const TOP_K_PER_END   = 18;
// Per cell, how many pair candidates to build (one high + one low, no
// replacement). 3 × 30 cells = 90 raw candidates; we trim to TARGET_PAIRS
// after applying the per-category cap.
const PAIRS_PER_CELL  = 3;
// Total pair count we hand to the UI. Over-generated relative to the 50-
// pick goal so the UI has buffer for "neither" clicks. See header comment.
const TARGET_PAIRS    = 80;
// Hard cap on how many pair slots a single category can occupy. Without
// this, if one category has super-rich axis coverage it could dominate
// and the gauntlet would feel like "pick 30 bags." 16/80 = 20% per cat
// keeps distribution near-uniform across the 6 categories.
const MAX_PER_CAT     = 16;

// Anchor vector for Pinecone queries. We just need ANY 512-dim vector
// because the metadata filter is what selects products; cosine ranking
// within the filtered set gives us a deterministic order without
// additional cost. Lazy-loaded once per request.
let anchorVectorCache: number[] | null = null;
async function getAnchorVector(): Promise<number[] | null> {
  if (anchorVectorCache) return anchorVectorCache;
  try {
    const idx = await getPineconeIndex();
    // Sample by querying with a unit vector; metadata-free top-1 returns
    // any product whose vector is closest to that direction. Good enough.
    const probe = Array.from({ length: 512 }, (_, i) => (i % 2 === 0 ? 0.05 : -0.05));
    const res   = await idx.query({ vector: probe, topK: 1, includeMetadata: false, includeValues: true });
    const match = res.matches?.[0] as { values?: number[] } | undefined;
    if (match?.values && match.values.length > 0) {
      anchorVectorCache = Array.from(match.values);
      return anchorVectorCache;
    }
  } catch {
    // Pinecone unavailable — caller will surface 500.
  }
  return null;
}

interface Pair {
  id:       string;
  axis:     typeof AXES[number];
  category: typeof CATEGORIES[number];
  a:        AlgoliaProduct;
  b:        AlgoliaProduct;
}

interface CandidateIDs {
  axis:     typeof AXES[number];
  category: typeof CATEGORIES[number];
  high:     string[];
  low:      string[];
}

async function fetchCandidatesForCell(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  idx:      any,
  anchor:   number[],
  category: typeof CATEGORIES[number],
  axis:     typeof AXES[number],
): Promise<CandidateIDs> {
  const baseFilter = { category };
  const [highRes, lowRes] = await Promise.all([
    idx.query({
      vector:          anchor,
      topK:            TOP_K_PER_END,
      includeMetadata: false,
      filter:          { ...baseFilter, [axis]: { $gte: HIGH_THRESHOLD } },
    }).catch(() => ({ matches: [] })),
    idx.query({
      vector:          anchor,
      topK:            TOP_K_PER_END,
      includeMetadata: false,
      filter:          { ...baseFilter, [axis]: { $lte: LOW_THRESHOLD } },
    }).catch(() => ({ matches: [] })),
  ]);

  const high = (highRes.matches ?? []).map((m: { id: string }) => m.id);
  const low  = (lowRes.matches  ?? []).map((m: { id: string }) => m.id);
  return { axis, category, high, low };
}

/**
 * Fisher-Yates in-place shuffle. Using crypto for slightly better
 * non-determinism than Math.random — not security-critical, just nicer
 * variety across calls.
 */
function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function GET() {
  const anchor = await getAnchorVector();
  if (!anchor) {
    return NextResponse.json(
      { error: "Pinecone anchor unavailable — cannot generate pairs" },
      { status: 500 },
    );
  }

  const idx = await getPineconeIndex();

  // Fetch all 30 cells (6 cats × 5 axes) in parallel. Each cell is two
  // Pinecone queries, so 60 queries total — Pinecone handles this fine
  // at the parallelism level.
  const cellPromises: Array<Promise<CandidateIDs>> = [];
  for (const category of CATEGORIES) {
    for (const axis of AXES) {
      cellPromises.push(fetchCandidatesForCell(idx, anchor, category, axis));
    }
  }
  const cells = await Promise.all(cellPromises);

  // Build candidate pairs per cell. Each cell contributes up to 2 pairs.
  // We pick high/low samples without replacement so a single product
  // doesn't appear in multiple pairs from the same cell.
  interface CandidatePair {
    id:       string;
    axis:     typeof AXES[number];
    category: typeof CATEGORIES[number];
    aId:      string;
    bId:      string;
  }
  const candidates: CandidatePair[] = [];
  for (const cell of cells) {
    const highPool = shuffleInPlace([...cell.high]);
    const lowPool  = shuffleInPlace([...cell.low]);
    const cellPairs = Math.min(highPool.length, lowPool.length, PAIRS_PER_CELL);
    for (let i = 0; i < cellPairs; i++) {
      const high = highPool[i];
      const low  = lowPool[i];
      if (!high || !low || high === low) continue;
      // Randomize which side is "a" so the UI shows them as a real
      // forced choice rather than "always high on the left."
      const flip = Math.random() < 0.5;
      candidates.push({
        id:       `${cell.category}-${cell.axis}-${i}`,
        axis:     cell.axis,
        category: cell.category,
        aId:      flip ? high : low,
        bId:      flip ? low  : high,
      });
    }
  }

  // Apply per-category cap so distribution stays balanced even if one
  // category has dramatically richer axis coverage in the catalog.
  const perCatCount: Record<string, number> = {};
  const balanced: CandidatePair[] = [];
  shuffleInPlace(candidates);
  for (const c of candidates) {
    const used = perCatCount[c.category] ?? 0;
    if (used >= MAX_PER_CAT) continue;
    balanced.push(c);
    perCatCount[c.category] = used + 1;
    if (balanced.length >= TARGET_PAIRS + 12) break; // +12 for hydration drop buffer
  }

  // Hydrate every product ID through Algolia in one batched call.
  const allIds = Array.from(new Set(balanced.flatMap((p) => [p.aId, p.bId])));
  const products = await getProductsByIds(allIds);
  const byId = new Map(products.map((p) => [p.objectID, p] as const));

  const pairs: Pair[] = [];
  for (const c of balanced) {
    const a = byId.get(c.aId);
    const b = byId.get(c.bId);
    if (!a || !b) continue; // hydration miss — skip
    pairs.push({ id: c.id, axis: c.axis, category: c.category, a, b });
    if (pairs.length >= TARGET_PAIRS) break;
  }

  return NextResponse.json({ pairs, count: pairs.length });
}
