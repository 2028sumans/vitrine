/**
 * POST /api/shop-all
 *
 * Paginated catalog listing for /shop. Three lanes:
 *
 *   (a) No filter, no signals — 8-slice catalog walk: fires 8 parallel Algolia
 *       queries at evenly-spaced offsets across the catalog and round-robin
 *       interleaves the hits so a single 48-product page mixes 8 different
 *       brand clusters instead of 48 consecutive items from one brand.
 *       (Currently unreachable from /shop since the UI always sends a filter,
 *       but retained for /shop-all sanity / future flat views.)
 *
 *   (b) Brand or category filter — hard-scope to that lens. Paginated walk
 *       within the scope. Bias/Steer signals still rank-boost within the
 *       scope but don't trim it.
 *
 *   (c) Session signals without scope (likes/dislikes from the session) —
 *       query-driven taste search across the whole catalog.
 */

import { NextResponse }  from "next/server";
import { algoliasearch } from "algoliasearch";

export const revalidate = 60;

const INDEX_NAME    = "vitrine_products";
const NUM_SLICES    = 8;
const PER_SLICE     = 6;
const CATALOG_SIZE  = 120_000;
const HITS_PER_PAGE = 48;

// ── Category scopes ──────────────────────────────────────────────────────────
// Display label → Algolia scope. The catalog's `category` field holds one of
// six values (dress/top/bottom/jacket/shoes/bag). The display lanes expose
// more granular labels; we map them to category filters plus an optional
// keyword query. Knits is a cross-category keyword search because the catalog
// has no knit attribute yet. Other is the residual of anything uncategorised.

const CORE_CATS = ["dress", "top", "bottom", "jacket", "shoes", "bag"] as const;

type CategoryScope = {
  /** Algolia `filters` expression, or null for no filter. */
  filters: string | null;
  /** Words injected into the Algolia `query` (with optionalWords ranking). */
  keywords: string[];
};

function scopeForCategory(label: string): CategoryScope | null {
  switch (label.toLowerCase().trim()) {
    case "tops":                 return { filters: 'category:"top"',    keywords: [] };
    case "dresses":              return { filters: 'category:"dress"',  keywords: [] };
    case "bottoms":              return { filters: 'category:"bottom"', keywords: [] };
    case "shoes":                return { filters: 'category:"shoes"',  keywords: [] };
    case "outerwear":            return { filters: 'category:"jacket"', keywords: [] };
    case "bags and accessories": return { filters: 'category:"bag"',    keywords: [] };
    case "knits":                return { filters: null, keywords: ["knit", "sweater", "cardigan", "cashmere", "wool"] };
    case "other": {
      // Everything uncategorised or falling outside the six core buckets.
      const parts = CORE_CATS.map((c) => `NOT category:"${c}"`);
      return { filters: parts.join(" AND "), keywords: [] };
    }
    default: return null;
  }
}

interface BiasPayload {
  likedBrands?:         string[];
  likedCategories?:     string[];
  likedColors?:         string[];
  dislikedBrands?:      string[];
  dislikedCategories?:  string[];
}

interface SteerInterp {
  search_terms?: string[];
  avoid_terms?:  string[];
  price_range?:  "budget" | "mid" | "luxury" | null;
  categories?:   string[];
  colors?:       string[];
}

function buildQueryFromBias(bias: BiasPayload): string {
  const terms: string[] = [];
  for (const b of bias.likedBrands      ?? []) terms.push(b);
  for (const c of bias.likedCategories  ?? []) terms.push(c);
  for (const c of bias.likedColors      ?? []) terms.push(c);
  return terms.filter(Boolean).join(" ").trim();
}

function hasLikedSignals(bias: BiasPayload): boolean {
  return (bias.likedBrands?.length ?? 0) > 0
      || (bias.likedCategories?.length ?? 0) > 0
      || (bias.likedColors?.length ?? 0) > 0;
}

function hasSteerSignals(s: SteerInterp | null): boolean {
  if (!s) return false;
  return (s.search_terms?.length ?? 0) > 0
      || (s.avoid_terms?.length  ?? 0) > 0
      || !!s.price_range
      || (s.categories?.length   ?? 0) > 0
      || (s.colors?.length       ?? 0) > 0;
}

function buildSteerQuery(s: SteerInterp | null): string {
  if (!s) return "";
  const terms: string[] = [];
  for (const t of s.search_terms ?? []) terms.push(t);
  for (const c of s.colors       ?? []) terms.push(c);
  for (const c of s.categories   ?? []) terms.push(c);
  return terms.filter(Boolean).join(" ").trim();
}

// Apply the semantic pieces of a SteerInterp (price_range, categories,
// colors, avoid_terms) as a lenient post-filter. Lenient means: only drops
// a product if it HAS the field and the field disagrees — products missing
// the field are kept so we don't nuke the whole feed over incomplete data.
function applySteerPostFilter(
  products: Array<Record<string, unknown>>,
  s: SteerInterp | null,
): Array<Record<string, unknown>> {
  if (!s) return products;
  const priceRange = s.price_range;
  const cats       = (s.categories ?? []).map((c) => c.toLowerCase().trim()).filter(Boolean);
  const cols       = (s.colors     ?? []).map((c) => c.toLowerCase().trim()).filter(Boolean);
  const avoids     = (s.avoid_terms ?? []).map((a) => a.toLowerCase().trim()).filter((a) => a.length > 2);
  if (!priceRange && cats.length === 0 && cols.length === 0 && avoids.length === 0) return products;

  return products.filter((p) => {
    if (priceRange) {
      const pr = String(p.price_range ?? "").toLowerCase().trim();
      if (pr && pr !== priceRange) return false;
    }
    if (cats.length > 0) {
      const pc = String(p.category ?? "").toLowerCase().trim();
      if (pc && !cats.some((c) => pc.includes(c) || c.includes(pc))) return false;
    }
    if (cols.length > 0) {
      const pcol = String(p.color ?? "").toLowerCase().trim();
      if (pcol && !cols.some((c) => pcol.includes(c))) return false;
    }
    if (avoids.length > 0) {
      const hay = `${String(p.title ?? "")} ${String(p.category ?? "")} ${String(p.color ?? "")}`.toLowerCase();
      if (avoids.some((a) => hay.includes(a))) return false;
    }
    return true;
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const page: number = Math.max(0, parseInt(String(body?.page ?? 0), 10) || 0);
  const bias: BiasPayload = body?.bias ?? {};
  const brandFilter:    string = typeof body?.brandFilter    === "string" ? body.brandFilter.trim()    : "";
  const categoryFilter: string = typeof body?.categoryFilter === "string" ? body.categoryFilter.trim() : "";
  const steerInterp: SteerInterp | null = body?.steerInterp ?? null;
  const steerQueryRaw: string = typeof body?.steerQuery === "string" ? body.steerQuery.trim() : "";
  const steerQuery = hasSteerSignals(steerInterp)
    ? buildSteerQuery(steerInterp)
    : steerQueryRaw;

  const appId = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? "BSDU5QFOT3";
  const key   = process.env.ALGOLIA_SEARCH_KEY
    ?? process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_KEY
    ?? process.env.ALGOLIA_ADMIN_KEY;

  if (!appId || !key) {
    return NextResponse.json({ error: "Missing Algolia credentials" }, { status: 500 });
  }

  const attributesToRetrieve = [
    "objectID", "title", "brand", "retailer", "price",
    "image_url", "product_url",
    "category", "color", "price_range",
  ];

  // Resolve scope filters. Brand and category are mutually exclusive — the UI
  // only ever sends one. If both arrive, brand wins (narrower scope, matches
  // pre-existing behavior where /brands cards deep-link into /shop).
  const brandFilterQuery = brandFilter
    ? `brand:"${brandFilter.replace(/"/g, '\\"')}" OR retailer:"${brandFilter.replace(/"/g, '\\"')}"`
    : "";
  const categoryScope = !brandFilter && categoryFilter ? scopeForCategory(categoryFilter) : null;

  try {
    const client = algoliasearch(appId, key);

    if (brandFilterQuery || categoryScope) {
      // Scoped mode (brand OR category). Steer query folds in as optionalWords
      // so it rank-boosts rather than narrowing. Bias likes also rank-boost
      // within the scope. Dislikes are NOT applied as a post-filter here — a
      // whole scope shouldn't get trimmed by cross-scope dislikes.
      const biasQuery = hasLikedSignals(bias) ? buildQueryFromBias(bias) : "";
      const scopedKeywords = categoryScope?.keywords?.join(" ") ?? "";
      const q = [steerQuery, biasQuery, scopedKeywords].filter(Boolean).join(" ");
      const optionalWords = q ? q.split(/\s+/).filter(Boolean) : undefined;
      const filters = brandFilterQuery || categoryScope?.filters || "";

      const res = await client.searchSingleIndex({
        indexName: INDEX_NAME,
        searchParams: {
          query:       q,
          ...(optionalWords ? { optionalWords } : {}),
          ...(filters ? { filters } : {}),
          hitsPerPage: HITS_PER_PAGE,
          page,
          attributesToRetrieve,
        },
      });
      let products = (res.hits ?? []) as Array<Record<string, unknown>>;

      // Structured Steer post-filter (price tier / category / color / avoid).
      products = applySteerPostFilter(products, steerInterp);

      const clean = products.filter((h) => {
        const u = h.image_url;
        return typeof u === "string" && u.startsWith("http");
      });

      return NextResponse.json({
        products: clean,
        page,
        hasMore:  (res.hits?.length ?? 0) >= HITS_PER_PAGE,
        mode:     brandFilterQuery ? "brand" : "category",
        brand:    brandFilter    || undefined,
        category: categoryFilter || undefined,
        steer:    steerQuery     || undefined,
        total:    res.nbHits ?? null,
      });
    }

    // ── Query-driven path: session signals without a hard scope ──────────
    if (steerQuery || hasLikedSignals(bias)) {
      const biasQuery = hasLikedSignals(bias) ? buildQueryFromBias(bias) : "";
      const q = [steerQuery, biasQuery].filter(Boolean).join(" ");
      const optionalWords = q.split(/\s+/).filter(Boolean);
      const res = await client.searchSingleIndex({
        indexName: INDEX_NAME,
        searchParams: {
          query:       q,
          optionalWords,
          hitsPerPage: HITS_PER_PAGE,
          page,
          attributesToRetrieve,
        },
      });
      let products = (res.hits ?? []) as Array<Record<string, unknown>>;

      const dislikedBrands     = new Set((bias.dislikedBrands     ?? []).map((s) => s.toLowerCase()));
      const dislikedCategories = new Set((bias.dislikedCategories ?? []).map((s) => s.toLowerCase()));
      if (dislikedBrands.size > 0 || dislikedCategories.size > 0) {
        products = products.filter((p) => {
          const b = String((p.brand ?? p.retailer ?? "")).toLowerCase();
          const c = String((p.category ?? "")).toLowerCase();
          if (dislikedBrands.has(b)) return false;
          if (c && dislikedCategories.has(c)) return false;
          return true;
        });
      }

      products = applySteerPostFilter(products, steerInterp);

      const clean = products.filter((p) => {
        const u = p.image_url;
        return typeof u === "string" && u.startsWith("http");
      });

      return NextResponse.json({
        products: clean,
        page,
        hasMore: (res.hits?.length ?? 0) >= HITS_PER_PAGE,
        mode:    steerQuery ? (hasLikedSignals(bias) ? "steered+biased" : "steered") : "biased",
        query:   q,
      });
    }

    // ── Default path: 8-slice catalog walk, interleaved ──────────────────
    const STRIDE = Math.floor(CATALOG_SIZE / NUM_SLICES);
    const offsets = Array.from({ length: NUM_SLICES }, (_, i) =>
      (page * PER_SLICE + i * STRIDE) % CATALOG_SIZE
    );

    const sliceResults = await Promise.all(
      offsets.map(async (off) => {
        try {
          const res = await client.searchSingleIndex({
            indexName: INDEX_NAME,
            searchParams: {
              query:  "",
              offset: off,
              length: PER_SLICE,
              attributesToRetrieve,
            },
          });
          return { hits: (res.hits ?? []) as Array<Record<string, unknown>> };
        } catch (e) {
          console.warn("[shop-all] slice failed (offset=" + off + "):", e instanceof Error ? e.message : e);
          return { hits: [] };
        }
      }),
    );

    const interleaved: Array<Record<string, unknown>> = [];
    for (let i = 0; i < PER_SLICE; i++) {
      for (let j = 0; j < NUM_SLICES; j++) {
        const hit = sliceResults[j]?.hits?.[i];
        if (hit) interleaved.push(hit);
      }
    }

    const products = interleaved.filter((h) => {
      const u = h.image_url;
      return typeof u === "string" && u.startsWith("http");
    });

    const hasMore = sliceResults.every((r) => (r.hits?.length ?? 0) >= PER_SLICE);

    return NextResponse.json({ products, page, hasMore, mode: "flat" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shop-all] failed:", message);
    return NextResponse.json({ error: "Failed", detail: message }, { status: 500 });
  }
}
