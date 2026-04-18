/**
 * GET /api/shop-all?page=N
 *
 * Paginated flat-catalog listing for the /shop page. Uses the server-side
 * ALGOLIA_SEARCH_KEY (already set on Vercel) so we don't need to expose the
 * search key to the browser via NEXT_PUBLIC_*.
 *
 * Cache: 5 min at the edge — the catalog only changes on adds/deletes, and a
 * little staleness on a browse page is fine.
 */

import { NextResponse }  from "next/server";
import { algoliasearch } from "algoliasearch";

export const revalidate = 300;

const INDEX_NAME    = "vitrine_products";
const HITS_PER_PAGE = 48;

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
    const res = await client.searchSingleIndex({
      indexName: INDEX_NAME,
      searchParams: {
        query:                "",
        hitsPerPage:          HITS_PER_PAGE,
        page,
        attributesToRetrieve: [
          "objectID", "title", "brand", "retailer", "price", "image_url", "product_url",
        ],
      },
    });

    const products = (res.hits ?? []).filter((h) => {
      const url = (h as { image_url?: unknown }).image_url;
      return typeof url === "string" && url.startsWith("http");
    });

    return NextResponse.json({
      products,
      page,
      hasMore: (res.hits?.length ?? 0) >= HITS_PER_PAGE,
      total:   res.nbHits ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shop-all] failed:", message);
    return NextResponse.json({ error: "Failed", detail: message }, { status: 500 });
  }
}
