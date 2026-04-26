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
import { resolveAgeCentroid } from "@/lib/taste-profile";
import { isAgeRangeKey, type AgeRangeKey } from "@/lib/onboarding-memory";

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

// When age bias is active, pinecone returns items SORTED by similarity to
// the age centroid (closest first). To make the bias actually pronounced,
// we only sample axis pools from the top AGE_BIAS_POOL_SIZE items per
// category. The remaining items in the topK=240 fetch are "kinda age-
// aligned, kinda not" and would dilute the signal if mixed in.
//
// Tuned 100 → 150 after first cut produced only 31 pairs for sparse age
// buckets like 13-18 (where labeled examples are limited and the top-100
// cluster very tightly, leaving low pools empty for some axes).
const AGE_BIAS_POOL_SIZE = 150;

// Within each axis-end pool (e.g., the high-formality items in tops),
// only consider the top CELL_TIGHT_TOP items by Pinecone similarity to
// the query vector. Without this, shuffleInPlace would randomize across
// the entire axis pool — which on age-biased fetches mixes the most
// age-aligned items with the lukewarm 80th-percentile tail. Top-N keeps
// pairs tightly age-aligned while still giving cross-call variety so two
// users in the same age bucket don't see identical sequences.
//
// Tuned 10 → 14 after first cut: top-10 was so tight that dedup kept
// catching the same items across multiple axis cells (an item high on
// formality is often also high on minimalism among age-aligned tops),
// collapsing pair counts. 14 gives enough cross-axis breathing room
// without losing the tight-aligned ranking.
const CELL_TIGHT_TOP = 14;

// Pinecone stores category as singular ("top", "dress", "bottom", etc.) —
// matching the catalog's `category` field. The age-centroid file uses the
// display-slug form ("tops", "dresses", "bags-and-accessories") matching
// /shop's category routes. Map between them so resolveAgeCentroid finds
// the right per-category centroid for each Pinecone category.
const CATEGORY_TO_AGE_SLUG: Record<CategoryKey, string> = {
  top:    "tops",
  dress:  "dresses",
  bottom: "bottoms",
  jacket: "outerwear",
  shoes:  "shoes",
  bag:    "bags-and-accessories",
};
// Per-category fetch breadth. Old client-side-partition version used 120
// and got 50 pairs total — short of the 80-pair buffer the UI needs for
// "neither" tolerance. 240 doubles raw coverage; with the looser
// thresholds above, expected output recovers to 80+ pairs.
const PER_CAT_TOP_K  = 240;
// Pairs per (category × axis) cell. Higher = more pairs per request but
// more dedup hits when items overlap across axes. 4 hit the sweet spot
// after the bias clamps tightened: produces ~70-90 unique pairs after
// dedup vs ~30-50 at PAIRS_PER_CELL=3.
const PAIRS_PER_CELL = 4;
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

export async function GET(request: Request) {
  // Optional age bias — when the user has picked an age range on step 1,
  // the frontend passes ?age=age-25-32. We use that age's centroid (per
  // category, with cross-category fallback for unlabeled cats like shoes
  // / bags) as the Pinecone query vector, so the per-category fetch
  // returns items biased toward what users in that age range actually
  // like (per the hand-labeled golden datasets).
  //
  // When no age is provided OR when an age has no centroid yet, we fall
  // back to the generic anchor vector so the gauntlet still works for
  // users who skipped age, anonymous testing, etc.
  //
  // The age centroid is ALSO blended at downstream save time via
  // loadUserTasteVector (weight 0.4 vs upload weight 1.0), so this
  // candidate-set bias is additive — picks made on age-appropriate
  // pairs feed into a centroid that gets re-mixed with the age prior
  // for ranking. Two-stage age bias = better calibration than either
  // stage alone.
  const url       = new URL(request.url);
  const ageParam  = url.searchParams.get("age");
  const ageRange: AgeRangeKey | null = isAgeRangeKey(ageParam) ? ageParam : null;

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
  //
  // Per-category query vector: age centroid for that category (when age
  // provided AND centroid exists for the (cat × age) pair, falling back
  // to cross-cat average for that age, then to anchor as the floor).
  //
  // Important: when ageVec is in play, Pinecone returns items sorted by
  // similarity to that centroid. We slice to AGE_BIAS_POOL_SIZE (top-100)
  // BEFORE partitioning so axis pools draw from items that are tightly
  // age-aligned, not from the lukewarm tail of the 240-item fetch. The
  // anchor-vector path (no age) keeps the full 240 since there's no age
  // signal to preserve.
  const cellsByCategory: CategoryCells[] = await Promise.all(
    CATEGORIES.map(async (category) => {
      const ageVec = ageRange
        ? resolveAgeCentroid(ageRange, CATEGORY_TO_AGE_SLUG[category])
        : null;
      const queryVec = ageVec ?? anchor;
      const allItems = await fetchCategoryItems(idx, queryVec, category);
      // Clamp to top-N when age-biased; full pool when not.
      const items = ageVec ? allItems.slice(0, AGE_BIAS_POOL_SIZE) : allItems;
      return { category, axes: partitionByAxes(items) };
    }),
  );

  // Build candidate pairs from each (category, axis) cell.
  //
  // Pair-signature dedup: a single product can be high on formality AND
  // high on romance, with the same low-axis partner appearing on both
  // sides. Without this set, the SAME (X, Y) pair could surface twice
  // under different "axis" labels — wasted slot from the user's POV
  // since their preference signal was already captured. Sorted-tuple
  // signature catches both (X, Y) and (Y, X) as the same pair.
  const candidates: CandidatePair[] = [];
  const seenPairs  = new Set<string>();
  for (const cat of cellsByCategory) {
    for (const cell of cat.axes) {
      // cell.high/low are ordered by Pinecone similarity (most-aligned
      // first). Slice to top CELL_TIGHT_TOP BEFORE shuffling so the
      // shuffle randomizes only among the strongest age-aligned items —
      // not across the tail of the pool. This is the second clamp that
      // makes age bias actually visible: AGE_BIAS_POOL_SIZE narrows the
      // category fetch, CELL_TIGHT_TOP narrows each axis-end pool.
      const highPool = shuffleInPlace(cell.high.slice(0, CELL_TIGHT_TOP));
      const lowPool  = shuffleInPlace(cell.low.slice(0, CELL_TIGHT_TOP));
      const cellPairs = Math.min(highPool.length, lowPool.length, PAIRS_PER_CELL);
      for (let i = 0; i < cellPairs; i++) {
        const high = highPool[i];
        const low  = lowPool[i];
        if (!high || !low || high === low) continue;
        // Sorted-tuple signature so (X, Y) and (Y, X) collapse into one.
        // Without this, item X high on formality + low on romance, paired
        // against item Y with the inverse, can produce the same physical
        // pair under two different "axis" labels.
        const sig = high < low ? `${high}|${low}` : `${low}|${high}`;
        if (seenPairs.has(sig)) continue;
        seenPairs.add(sig);
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
    {
      pairs,
      count:    pairs.length,
      ageRange: ageRange ?? null,  // echoes the bias applied — useful for client debugging
    },
    { headers: NO_CACHE_HEADERS },
  );
}
