/**
 * POST /api/shop-all
 *
 * Paginated flat-catalog listing for /shop, with TWO behaviors:
 *
 *   (a) No session signals — 8-slice catalog walk: fires 8 parallel Algolia
 *       queries at evenly-spaced offsets across the catalog and round-robin
 *       interleaves the hits so a single 48-product page mixes 8 different
 *       brand clusters instead of 48 consecutive items from one brand.
 *
 *   (b) With signals (likes/dislikes from the current session) — switch to a
 *       text-query-driven search biased by the user's accumulated taste:
 *         q = top liked brand + category + color terms concatenated
 *         + client-side post-filter against strongly-disliked brands
 *       Each page yields the next 48 results of that biased query, which
 *       ranges over ALL products in the catalog (not just a fixed 48).
 *
 * Signals arrive as arrays of plain strings so composition stays trivial.
 */

import { NextResponse }  from "next/server";
import { algoliasearch } from "algoliasearch";

export const revalidate = 60; // shorter TTL since signals vary per request

const INDEX_NAME    = "vitrine_products";
const NUM_SLICES    = 8;
const PER_SLICE     = 6;       // 8 * 6 = 48 per page
const CATALOG_SIZE  = 120_000; // rough
const HITS_PER_PAGE = 48;

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
    // Price tier — exact match when product has the field.
    if (priceRange) {
      const pr = String(p.price_range ?? "").toLowerCase().trim();
      if (pr && pr !== priceRange) return false;
    }
    // Category — substring match (product's "dress" matches ["dress", "top"]).
    if (cats.length > 0) {
      const pc = String(p.category ?? "").toLowerCase().trim();
      if (pc && !cats.some((c) => pc.includes(c) || c.includes(pc))) return false;
    }
    // Color — substring match.
    if (cols.length > 0) {
      const pcol = String(p.color ?? "").toLowerCase().trim();
      if (pcol && !cols.some((c) => pcol.includes(c))) return false;
    }
    // Avoid words appear anywhere in title/category/color.
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
  const brandFilter: string = typeof body?.brandFilter === "string" ? body.brandFilter.trim() : "";
  // Structured Steer interpretation from the client (Claude-parsed). Holds
  // search_terms + avoid_terms + price_range + categories + colors. See
  // lib/steer-interpret.ts for the schema. Falls back to the raw steerQuery
  // if an older client hasn't been upgraded yet.
  const steerInterp: SteerInterp | null = body?.steerInterp ?? null;
  const steerQueryRaw: string = typeof body?.steerQuery === "string" ? body.steerQuery.trim() : "";
  // Effective text query: prefer the structured interp's search terms, else
  // fall back to the raw text. Empty string if neither is set.
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

  // Brand-scoped mode: /brands cards link here with ?brand= → we hard-filter
  // the catalog to just that brand and serve paginated results in whatever
  // order Algolia returns. Bias signals are ignored in brand mode — the
  // whole point is to see everything from THIS brand.
  const brandFilterQuery = brandFilter
    ? `brand:"${brandFilter.replace(/"/g, '\\"')}" OR retailer:"${brandFilter.replace(/"/g, '\\"')}"`
    : "";

  try {
    const client = algoliasearch(appId, key);

    if (brandFilterQuery) {
      // Brand mode: show everything the brand has by default. We still
      // respect an explicit Steer query ("black only", "no prints", …) —
      // folded into the Algolia search as optionalWords so terms rank-
      // boost rather than hard-filter. Bias signals are otherwise ignored
      // here (see note below) so the whole inventory stays reachable.
      //
      // Why no bias query: Algolia treats `query` + `filters` as AND, so
      // layering a bias text like "Everlane jacket white" on top of
      // brand:"4028" drops the brand's 25 products down to 0–3. Within-
      // brand taste re-ranking still happens client-side via the scoring
      // algorithm. Disliked-category post-filter is also skipped — a
      // whole brand scope shouldn't get trimmed by cross-brand dislikes.
      const optionalWords = steerQuery
        ? steerQuery.split(/\s+/).filter(Boolean)
        : undefined;
      const res = await client.searchSingleIndex({
        indexName: INDEX_NAME,
        searchParams: {
          query:       steerQuery,
          ...(optionalWords ? { optionalWords } : {}),
          filters:     brandFilterQuery,
          hitsPerPage: HITS_PER_PAGE,
          page,
          attributesToRetrieve,
        },
      });
      let products = (res.hits ?? []) as Array<Record<string, unknown>>;

      // Post-filter by structured Steer directives (price tier, category,
      // color, avoid words) so "cheaper", "no florals", etc actually work.
      products = applySteerPostFilter(products, steerInterp);

      const clean = products.filter((h) => {
        const u = h.image_url;
        return typeof u === "string" && u.startsWith("http");
      });

      return NextResponse.json({
        products: clean,
        page,
        hasMore:  (res.hits?.length ?? 0) >= HITS_PER_PAGE,
        mode:     "brand",
        brand:    brandFilter,
        steer:    steerQuery || undefined,
        total:    res.nbHits ?? null,
      });
    }

    // ── Query-driven path: fires whenever the user has signaled anything
    //     — either an explicit Steer query, or bias from their likes. In
    //     both cases we run ONE Algolia search over the full catalog and
    //     treat every term as optionalWords (ranking hint, not filter).
    if (steerQuery || hasLikedSignals(bias)) {
      const biasQuery = hasLikedSignals(bias) ? buildQueryFromBias(bias) : "";
      // Steer first so it dominates the relevance score; bias words follow.
      const q = [steerQuery, biasQuery].filter(Boolean).join(" ");
      // Mark every word as optional. Algolia's default AND semantics would
      // otherwise require every term to match simultaneously — e.g.
      // "Everlane dress white" → 0 hits because almost no product has all
      // three words. With optionalWords, products matching ANY of the
      // terms come back and ones matching more terms rank higher.
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

      // Post-filter strongly disliked brands / categories
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

      // Steer post-filter (price, category, color, avoid terms).
      products = applySteerPostFilter(products, steerInterp);

      // Image-url sanity
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
