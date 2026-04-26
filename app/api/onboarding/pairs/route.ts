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
 * The UI offers a "neither" button per pair. Without a buffer, a "neither"-
 * heavy user could exhaust 50 pairs with only 20 positive picks. Over-
 * generating: 80 pairs server-side, target = 50 positive picks client-side.
 *
 * Why GET is force-dynamic
 * ------------------------
 * Next.js statically caches GET routes by default at the Vercel edge. For
 * this route that's a disaster: every onboarding user gets the same cached
 * pair sequence, killing the personalization signal value of the gauntlet
 * (everyone calibrating against identical pairs gives correlated centroids
 * that can't actually distinguish users from each other). The first user
 * also pays the entire backend cost while the cache is empty — and if
 * Pinecone has any cold-start hiccup, that cost balloons.
 *
 * Force-dynamic + no-store Cache-Control means every onboarding load gets
 * fresh, randomized pairs. Backend is fast enough now (~6 Pinecone queries
 * total, see Pair generation below) that always-fresh is cheap.
 *
 * Pair generation (after Nov 2026 latency rewrite)
 * ------------------------------------------------
 *   1. One anchor-vector query (topK=1) to get any product's CLIP vector.
 *      Used as the query vector for all subsequent metadata-filtered ones.
 *   2. SIX parallel Pinecone queries — one per category — each fetching
 *      topK=120 with `includeMetadata: true`. Metadata carries the five
 *      style-axis values per product, so we can partition into high/low
 *      pools client-side without further Pinecone trips.
 *   3. For each of 30 (category × axis) cells, partition the category's
 *      120 items by axis-value: high pool = items with axis ≥ 0.65, low
 *      pool = items with axis ≤ 0.35. Pair high with low, up to 3 per cell.
 *   4. Apply per-category cap (16) so distribution stays even.
 *   5. Hydrate via one Algolia getObjects call for titles + images.
 *
 * Latency budget after the rewrite:
 *   - 1 anchor query                             ~150ms cold, ~50ms warm
 *   - 6 parallel category queries (topK=120)     ~250ms cold, ~80ms warm
 *   - 1 Algolia getObjects with ~160 IDs         ~250ms cold, ~100ms warm
 *   Total: ~650ms cold, ~230ms warm.
 *
 * Previous implementation fired 60 parallel Pinecone queries (6 cats ×
 * 5 axes × 2 ends), which on cold start could trigger Pinecone's per-
 * connection rate limits and stall the whole batch. Six parallel queries
 * stay well within the limit and keep the gauntlet snappy.
 *
 * Response
 * --------
 *   200 { pairs: Array<{ id, axis, category, a, b }>, count }
 *   500 { error: "..." } on Pinecone / Algolia failure
 */

import { NextResponse } from "next/server";
import { getPineconeIndex } from "@/lib/embeddings";
import { getProductsByIds } from "@/lib/algolia";
import type { AlgoliaProduct } from "@/lib/algolia";

export const runtime       = "nodejs";
export const maxDuration   = 30;
// Block Next.js / Vercel edge caching. See header comment "Why GET is
// force-dynamic" for the user-impact reasoning.
export const dynamic       = "force-dynamic";
export const revalidate    = 0;

const CATEGORIES = ["top", "dress", "bottom", "jacket", "shoes", "bag"] as const;
const AXES       = ["formality", "minimalism", "edge", "romance", "drape"] as const;
type CategoryKey = typeof CATEGORIES[number];
type AxisKey     = typeof AXES[number];

// Slightly looser thresholds than the per-axis-filter version (0.65/0.35).
// Reason: when we filter Pinecone by axis directly, we always get the
// strictest top-K matching that filter from across the WHOLE catalog.
// Partitioning client-side from a per-category fetch is bounded by what
// shows up in our pre-fetch — sparser cells. 0.6/0.4 thresholds widen
// each pool by ~50% in practice without diluting contrast much (a 0.6
// vs 0.4 axis spread is still a clearly contrastive pair).
const HIGH_THRESHOLD = 0.60;
const LOW_THRESHOLD  = 0.40;
// Per-category fetch breadth. Old client-side-partition version used 120
// and got 50 pairs total — short of the 80-pair buffer the UI needs for
// "neither" tolerance. 240 doubles raw coverage; with the looser
// thresholds above, expected output recovers to 80+ pairs.
const PER_CAT_TOP_K  = 240;
const PAIRS_PER_CELL = 3;
const TARGET_PAIRS   = 80;
const MAX_PER_CAT    = 16;

// Standard Cache-Control for "expensive backend, must always run fresh."
// Vercel's edge respects no-store; combined with force-dynamic this guarantees
// every onboarding load hits the actual generator.
const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
};

/** Pinecone match shape we actually read. The SDK types are loose; we
 *  narrow inline. */
interface PineconeMatch {
  id:        string;
  metadata?: Record<string, unknown>;
}

/** One axis-contrastive cell's high+low pools, post-partition. */
interface AxisCell {
  axis: AxisKey;
  high: string[]; // product IDs with axis-value ≥ HIGH_THRESHOLD
  low:  string[]; // product IDs with axis-value ≤ LOW_THRESHOLD
}

/** All 5 axis cells for one category. */
interface CategoryCells {
  category: CategoryKey;
  axes:     AxisCell[];
}

/**
 * Anchor vector for Pinecone metadata-filtered queries. The actual
 * selection criterion is the metadata filter, not cosine similarity, but
 * Pinecone's `query` op requires a vector. One anchor reused across every
 * category query.
 *
 * Cached at module scope so warm lambdas skip the lookup. NOT TTL'd —
 * the anchor is just "any catalog vector," won't go stale within the
 * lambda's lifetime (and a fresh deploy resets the cache anyway).
 */
let anchorVectorCache: number[] | null = null;
async function getAnchorVector(): Promise<number[] | null> {
  if (anchorVectorCache) return anchorVectorCache;
  try {
    const idx = await getPineconeIndex();
    const probe = Array.from({ length: 512 }, (_, i) => (i % 2 === 0 ? 0.05 : -0.05));
    const res   = await idx.query({ vector: probe, topK: 1, includeMetadata: false, includeValues: true });
    const match = res.matches?.[0] as { values?: number[] } | undefined;
    if (match?.values && match.values.length > 0) {
      anchorVectorCache = Array.from(match.values);
      return anchorVectorCache;
    }
  } catch {
    /* Pinecone unavailable — caller surfaces 500. */
  }
  return null;
}

/**
 * One Pinecone query per category. Returns up to PER_CAT_TOP_K items
 * with their metadata (axis values + flat fields). Failures are caught
 * here so one bad category doesn't blow up the whole request.
 */
async function fetchCategoryItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  idx:      any,
  anchor:   number[],
  category: CategoryKey,
): Promise<PineconeMatch[]> {
  try {
    const res = await idx.query({
      vector:          anchor,
      topK:            PER_CAT_TOP_K,
      includeMetadata: true,
      filter:          { category },
    });
    return (res.matches ?? []) as PineconeMatch[];
  } catch {
    return [];
  }
}

/** Partition a category's items into per-axis high/low pools. */
function partitionByAxes(items: PineconeMatch[]): AxisCell[] {
  const cells: AxisCell[] = AXES.map((axis) => ({ axis, high: [], low: [] }));
  for (const item of items) {
    if (!item.metadata) continue;
    for (const cell of cells) {
      const v = item.metadata[cell.axis];
      const n = typeof v === "number" ? v : NaN;
      if (!Number.isFinite(n)) continue;
      if (n >= HIGH_THRESHOLD) cell.high.push(item.id);
      else if (n <= LOW_THRESHOLD) cell.low.push(item.id);
    }
  }
  return cells;
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

interface Pair {
  id:       string;
  axis:     AxisKey;
  category: CategoryKey;
  a:        AlgoliaProduct;
  b:        AlgoliaProduct;
}

interface CandidatePair {
  id:       string;
  axis:     AxisKey;
  category: CategoryKey;
  aId:      string;
  bId:      string;
}

export async function GET() {
  const anchor = await getAnchorVector();
  if (!anchor) {
    return NextResponse.json(
      { error: "Pinecone anchor unavailable — cannot generate pairs" },
      { status: 500, headers: NO_CACHE_HEADERS },
    );
  }

  const idx = await getPineconeIndex();

  // SIX parallel Pinecone queries — one per category. Each returns up to
  // PER_CAT_TOP_K items with full metadata. Keeping the parallel fan-out
  // small avoids hitting Pinecone's serverless connection limits.
  const cellsByCategory: CategoryCells[] = await Promise.all(
    CATEGORIES.map(async (category) => {
      const items = await fetchCategoryItems(idx, anchor, category);
      return { category, axes: partitionByAxes(items) };
    }),
  );

  // Build candidate pairs from each (category, axis) cell.
  const candidates: CandidatePair[] = [];
  for (const cat of cellsByCategory) {
    for (const cell of cat.axes) {
      const highPool = shuffleInPlace([...cell.high]);
      const lowPool  = shuffleInPlace([...cell.low]);
      const cellPairs = Math.min(highPool.length, lowPool.length, PAIRS_PER_CELL);
      for (let i = 0; i < cellPairs; i++) {
        const high = highPool[i];
        const low  = lowPool[i];
        if (!high || !low || high === low) continue;
        const flip = Math.random() < 0.5;
        candidates.push({
          id:       `${cat.category}-${cell.axis}-${i}`,
          axis:     cell.axis,
          category: cat.category,
          aId:      flip ? high : low,
          bId:      flip ? low  : high,
        });
      }
    }
  }

  // Apply per-category cap so distribution stays balanced even if one
  // category has unusually rich axis coverage.
  shuffleInPlace(candidates);
  const perCatCount: Record<string, number> = {};
  const balanced: CandidatePair[] = [];
  for (const c of candidates) {
    const used = perCatCount[c.category] ?? 0;
    if (used >= MAX_PER_CAT) continue;
    balanced.push(c);
    perCatCount[c.category] = used + 1;
    if (balanced.length >= TARGET_PAIRS + 12) break; // +12 hydration drop buffer
  }

  // Hydrate via one batched Algolia getObjects call.
  const allIds   = Array.from(new Set(balanced.flatMap((p) => [p.aId, p.bId])));
  const products = await getProductsByIds(allIds);
  const byId     = new Map(products.map((p) => [p.objectID, p] as const));

  const pairs: Pair[] = [];
  for (const c of balanced) {
    const a = byId.get(c.aId);
    const b = byId.get(c.bId);
    if (!a || !b) continue;
    pairs.push({ id: c.id, axis: c.axis, category: c.category, a, b });
    if (pairs.length >= TARGET_PAIRS) break;
  }

  return NextResponse.json(
    { pairs, count: pairs.length },
    { headers: NO_CACHE_HEADERS },
  );
}
