/**
 * GET /api/brands
 *
 * Fast path: get all brand facet values (names + counts) in one Algolia
 * search call, then fetch one representative product image per brand via
 * a multi-query batch. Total: ~1-2s regardless of catalog size.
 *
 * (Earlier version used browseObjects over the full catalog — worked locally
 * but timed out on Vercel serverless at ~30s scanning 138K records.)
 */

import { NextResponse } from "next/server";
import { algoliasearch } from "algoliasearch";

export const revalidate = 3600; // cache 1 hour

interface BrandEntry {
  name:     string;
  count:    number;
  imageUrl: string | null;
}

// Some retailers are white-label or low-quality — skip. Keep the list short.
const SKIP = new Set<string>([]);

export async function GET() {
  const appId = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID;
  const key = process.env.ALGOLIA_SEARCH_KEY
    ?? process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_KEY
    ?? process.env.ALGOLIA_ADMIN_KEY;

  if (!appId || !key) {
    return NextResponse.json({ error: "Missing Algolia credentials" }, { status: 500 });
  }

  const client = algoliasearch(appId, key);

  try {
    // 1) Pull facet values for retailer AND brand in one call.
    const facetResp = await client.searchSingleIndex({
      indexName: "vitrine_products",
      searchParams: {
        query:             "",
        hitsPerPage:        0,
        facets:             ["retailer", "brand"],
        maxValuesPerFacet:  1000,
      },
    });

    const facets = facetResp.facets ?? {};
    const retailers = (facets.retailer ?? {}) as Record<string, number>;
    const brands    = (facets.brand    ?? {}) as Record<string, number>;

    // Prefer retailer when present; fall back to brand (catalog rows should have one or the other).
    const merged = new Map<string, BrandEntry>();
    for (const [name, count] of Object.entries(retailers)) {
      if (!name || SKIP.has(name)) continue;
      merged.set(name, { name, count, imageUrl: null });
    }
    for (const [name, count] of Object.entries(brands)) {
      if (!name || SKIP.has(name)) continue;
      if (merged.has(name)) continue;
      merged.set(name, { name, count, imageUrl: null });
    }

    const list = Array.from(merged.values()).sort((a, b) => b.count - a.count);
    if (list.length === 0) return NextResponse.json({ brands: [], total: 0 });

    // 2) Batch fetch one image per brand via multipleQueries (single round-trip).
    //    Escape double quotes in brand names to keep the filter valid.
    const esc = (s: string) => s.replace(/"/g, '\\"');
    const requests = list.map((b) => ({
      indexName:    "vitrine_products",
      query:         "",
      filters:      `retailer:"${esc(b.name)}" OR brand:"${esc(b.name)}"`,
      hitsPerPage:   1,
      attributesToRetrieve: ["image_url"],
    }));

    const multiResp = await client.search({ requests });
    // Type-narrow: v5's `search` method returns a union — pick the shape that has `hits`.
    const results = (multiResp.results ?? []) as Array<{ hits?: Array<{ image_url?: string }> }>;

    for (let i = 0; i < list.length; i++) {
      const hit = results[i]?.hits?.[0];
      if (hit?.image_url && hit.image_url.startsWith("http")) {
        list[i].imageUrl = hit.image_url;
      }
    }

    return NextResponse.json({ brands: list, total: list.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[brands] failed:", message);
    return NextResponse.json({ error: "Failed to load brands", detail: message }, { status: 500 });
  }
}
