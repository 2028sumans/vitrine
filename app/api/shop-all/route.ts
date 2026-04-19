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

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const page: number = Math.max(0, parseInt(String(body?.page ?? 0), 10) || 0);
  const bias: BiasPayload = body?.bias ?? {};
  const brandFilter: string = typeof body?.brandFilter === "string" ? body.brandFilter.trim() : "";

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
      // Brand mode: show EVERYTHING the brand has. We deliberately do NOT
      // apply a bias-derived text query here — Algolia treats `query` as a
      // filter (hits must match query AND filters), so layering a taste
      // query like "Everlane jacket white" on top of brand:"4028" drops the
      // brand's 25 products down to whichever 0–3 happen to mention those
      // words. Within-brand taste re-ranking still happens client-side via
      // the scoring algorithm on returned products. We also skip the
      // dislikedCategories post-filter here for the same reason — an entire
      // brand scope shouldn't be trimmed based on cross-brand dislike counts.
      const res = await client.searchSingleIndex({
        indexName: INDEX_NAME,
        searchParams: {
          query:       "",
          filters:     brandFilterQuery,
          hitsPerPage: HITS_PER_PAGE,
          page,
          attributesToRetrieve,
        },
      });
      const products = (res.hits ?? []) as Array<Record<string, unknown>>;

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
        total:    res.nbHits ?? null,
      });
    }

    // ── Biased path: use a taste-query, ranges over the full catalog ──────
    if (hasLikedSignals(bias)) {
      const q = buildQueryFromBias(bias);
      // Mark every bias word as optional. Algolia's default AND semantics
      // would otherwise require every liked term to match simultaneously —
      // e.g. "Everlane dress white" → 0 hits because almost no product has
      // all three words. With optionalWords, products matching ANY of the
      // terms come back, and ones matching more terms rank higher. That's
      // the "bias" we actually want: a ranking hint, not a filter.
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

      // Image-url sanity
      const clean = products.filter((p) => {
        const u = p.image_url;
        return typeof u === "string" && u.startsWith("http");
      });

      return NextResponse.json({
        products: clean,
        page,
        hasMore: (res.hits?.length ?? 0) >= HITS_PER_PAGE,
        mode:    "biased",
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
