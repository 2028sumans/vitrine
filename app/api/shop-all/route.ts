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
// Over-fetch in scoped mode so interleaveByBrand has a wide enough pool to
// actually mix brands. Without this, a category like Shoes comes back as
// 48 consecutive Needledust rows because that's how Algolia's default
// ranking clumps them — interleaving 48 Needledust products yields 48
// Needledust products. 4x gives the mixer ~4 different brands' inventory
// to draw from per page.
const SCOPED_FETCH   = HITS_PER_PAGE * 4;

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
  /**
   * Strict check run as a post-filter on the Algolia hits. Belt-and-braces
   * guard against mis-tagged catalog rows (e.g. a hoodie with category="shoes"
   * slipping into the Shoes lane because the Algolia filter matched).
   * Return true to keep a product, false to drop it.
   */
  enforce?: (p: Record<string, unknown>) => boolean;
};

// Title-keyword blocklist per display category — words whose presence in
// a title strongly contradicts the category, even if the Algolia `category`
// tag claims otherwise. Catches mis-tagged rows without requiring a positive
// keyword match (which would over-filter legitimately-named pieces like
// "Belle Strapless" in Tops).
//
// Matched with word-start boundaries so "heel" won't hit "loopwheel".
const CATEGORY_BLOCKERS: Record<string, readonly string[]> = {
  tops:       ["shoe", "boot", "sandal", "heel", "sneaker", "loafer", "pump", "pant", "skirt", "dress", "jean", "trouser", "bag", "tote", "handbag", "clutch"],
  dresses:    ["shoe", "boot", "sandal", "heel", "sneaker", "loafer", "pump", "pant", "jean", "trouser", "bag", "tote", "handbag", "clutch", "jacket", "coat", "blazer"],
  bottoms:    ["shoe", "boot", "sandal", "heel", "sneaker", "loafer", "pump", "dress", "shirt", "blouse", "top", "tee", "tank", "jacket", "coat", "blazer", "bag", "tote", "handbag", "clutch"],
  shoes:      ["hoody", "hoodie", "sweater", "sweatshirt", "cardigan", "jumper", "shirt", "blouse", "tee", "tank", "dress", "gown", "pant", "skirt", "short", "jean", "trouser", "jacket", "coat", "blazer", "bag", "tote", "handbag", "clutch", "necklace", "bracelet", "ring", "earring", "belt"],
  outerwear:  ["shoe", "boot", "sandal", "heel", "sneaker", "loafer", "pump", "dress", "gown", "skirt", "short", "jean", "trouser", "bag", "tote", "handbag", "clutch"],
  "bags and accessories": ["shoe", "boot", "sandal", "heel", "sneaker", "pant", "skirt", "dress", "shirt", "blouse", "jacket", "coat"],
};

function passesCategoryBlocker(p: Record<string, unknown>, bucket: string): boolean {
  const blockers = CATEGORY_BLOCKERS[bucket];
  if (!blockers) return true;
  const title = String(p.title ?? "").toLowerCase();
  return !blockers.some((k) => new RegExp(`\\b${k}`, "i").test(title));
}

function scopeForCategory(label: string): CategoryScope | null {
  const key = label.toLowerCase().trim();
  switch (key) {
    case "tops":                 return { filters: 'category:"top"',    keywords: [], enforce: (p) => passesCategoryBlocker(p, "tops") };
    case "dresses":              return { filters: 'category:"dress"',  keywords: [], enforce: (p) => passesCategoryBlocker(p, "dresses") };
    case "bottoms":              return { filters: 'category:"bottom"', keywords: [], enforce: (p) => passesCategoryBlocker(p, "bottoms") };
    case "shoes":                return { filters: 'category:"shoes"',  keywords: [], enforce: (p) => passesCategoryBlocker(p, "shoes") };
    case "outerwear":            return { filters: 'category:"jacket"', keywords: [], enforce: (p) => passesCategoryBlocker(p, "outerwear") };
    case "bags and accessories": return { filters: 'category:"bag"',    keywords: [], enforce: (p) => passesCategoryBlocker(p, "bags and accessories") };
    case "knits": {
      // Knits IS keyword-driven, not a mis-tag guard — Algolia has no knit
      // category, so we keyword-search and require at least one positive
      // hit in the title so leggings/jeans/etc. don't leak in.
      const knitHints = ["knit", "sweater", "cardigan", "cashmere", "wool", "cable", "jumper", "pullover", "turtleneck"];
      return {
        filters:  null,
        keywords: ["knit", "sweater", "cardigan", "cashmere", "wool"],
        enforce:  (p) => {
          const title = String(p.title ?? "").toLowerCase();
          return knitHints.some((k) => new RegExp(`\\b${k}`, "i").test(title));
        },
      };
    }
    case "other": {
      const parts = CORE_CATS.map((c) => `NOT category:"${c}"`);
      return {
        filters:  parts.join(" AND "),
        keywords: [],
        enforce:  (p) => {
          const pc = String(p.category ?? "").toLowerCase().trim();
          return !pc || !CORE_CATS.includes(pc as typeof CORE_CATS[number]);
        },
      };
    }
    default: return null;
  }
}

// Round-robin by brand so a single batch doesn't clump a brand's entire
// inventory together. Group by brand (case-insensitive, falling back to
// retailer), then take one from each bucket in order until all are drained.
// Preserves Algolia's per-brand internal ranking while spreading brands out.
function interleaveByBrand<T extends Record<string, unknown>>(products: T[]): T[] {
  const byBrand = new Map<string, T[]>();
  for (const p of products) {
    const key = String(p.brand ?? p.retailer ?? "").toLowerCase().trim() || "__unknown__";
    const bucket = byBrand.get(key);
    if (bucket) bucket.push(p);
    else byBrand.set(key, [p]);
  }
  const buckets = Array.from(byBrand.values());
  const out: T[] = [];
  let anyLeft = true;
  while (anyLeft) {
    anyLeft = false;
    for (const bucket of buckets) {
      const p = bucket.shift();
      if (p !== undefined) {
        out.push(p);
        anyLeft = true;
      }
    }
  }
  return out;
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
          hitsPerPage: SCOPED_FETCH,
          page,
          attributesToRetrieve,
        },
      });
      let products = (res.hits ?? []) as Array<Record<string, unknown>>;

      // Structured Steer post-filter (price tier / category / color / avoid).
      products = applySteerPostFilter(products, steerInterp);

      // Strict category-scope enforcement — defensive against mis-tagged rows
      // in the Algolia index (e.g. hoodies slipping into Shoes).
      if (categoryScope?.enforce) {
        products = products.filter(categoryScope.enforce);
      }

      let clean = products.filter((h) => {
        const u = h.image_url;
        return typeof u === "string" && u.startsWith("http");
      });

      // Round-robin by brand so the page doesn't serve a long run of one
      // retailer. Requires the over-fetched pool (SCOPED_FETCH) to have
      // multiple brands in it — Algolia's default ranking otherwise clumps.
      clean = interleaveByBrand(clean);

      return NextResponse.json({
        products: clean,
        page,
        hasMore:  (res.hits?.length ?? 0) >= SCOPED_FETCH,
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

      let clean = products.filter((p) => {
        const u = p.image_url;
        return typeof u === "string" && u.startsWith("http");
      });

      clean = interleaveByBrand(clean);

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
