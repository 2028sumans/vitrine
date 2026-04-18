/**
 * GET /api/shop-all?page=N
 *
 * Paginated flat-catalog listing for /shop, with BRAND INTERLEAVING.
 *
 * Algolia's default order clusters products by retailer (because products were
 * uploaded in per-brand batches). A naive paginated pass gives the user "100
 * Camilla, then 50 Retrofete, then 200 Showpo" — visually monotonous.
 *
 * Strategy: for each requested page, we fire 8 parallel Algolia queries at
 * evenly-spaced offsets across the full catalog and then interleave the hits
 * (one from each slice, round-robin). A single page of 48 products therefore
 * pulls from 8 different parts of the catalog — effectively 8 different brand
 * clusters mixed together.
 *
 * The "user page" N shifts each slice's internal offset so subsequent pages
 * surface new products within each slice, not the same 48 over and over.
 */

import { NextResponse }  from "next/server";
import { algoliasearch } from "algoliasearch";

export const revalidate = 300;

const INDEX_NAME    = "vitrine_products";
const NUM_SLICES    = 8;
const PER_SLICE     = 6;     // 8 * 6 = 48 per page
const CATALOG_SIZE  = 120_000; // rough — used to evenly space slice offsets

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const page = Math.max(0, parseInt(searchParams.get("page") ?? "0", 10) || 0);

  const appId = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? "BSDU5QFOT3";
  const key   = process.env.ALGOLIA_SEARCH_KEY
    ?? process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_KEY
    ?? process.env.ALGOLIA_ADMIN_KEY;

  if (!appId || !key) {
    return NextResponse.json({ error: "Missing Algolia credentials" }, { status: 500 });
  }

  try {
    const client = algoliasearch(appId, key);

    // 8 offsets evenly spaced across the catalog. Each user-page walks
    // PER_SLICE items forward within each slice.
    const STRIDE = Math.floor(CATALOG_SIZE / NUM_SLICES);
    const offsets = Array.from({ length: NUM_SLICES }, (_, i) =>
      (page * PER_SLICE + i * STRIDE) % CATALOG_SIZE
    );

    // Multi-query batch: 8 mini-searches in one HTTP round-trip.
    // Algolia's `length` param caps at 1000 when using `offset`; 6 is fine.
    const requests = offsets.map((off) => ({
      indexName:            INDEX_NAME,
      query:                "",
      offset:               off,
      length:               PER_SLICE,
      attributesToRetrieve: [
        "objectID", "title", "brand", "retailer", "price", "image_url", "product_url",
      ],
    }));

    const batch = await client.search({ requests });
    const sliceResults = (batch.results ?? []) as Array<{
      hits?: Array<Record<string, unknown>>;
    }>;

    // Round-robin interleave: take slice 0's item i, then slice 1's item i, ...
    // slice 7's item i; then i+1 round. Produces [s0_0, s1_0, ..., s7_0, s0_1, ...].
    const interleaved: Array<Record<string, unknown>> = [];
    for (let i = 0; i < PER_SLICE; i++) {
      for (let j = 0; j < NUM_SLICES; j++) {
        const hit = sliceResults[j]?.hits?.[i];
        if (hit) interleaved.push(hit);
      }
    }

    // Filter products without a usable image URL
    const products = interleaved.filter((h) => {
      const url = h.image_url;
      return typeof url === "string" && url.startsWith("http");
    });

    // hasMore: if every slice returned a full batch, there's more to pull.
    const hasMore = sliceResults.every((r) => (r.hits?.length ?? 0) >= PER_SLICE);

    return NextResponse.json({ products, page, hasMore });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shop-all] failed:", message);
    return NextResponse.json({ error: "Failed", detail: message }, { status: 500 });
  }
}
