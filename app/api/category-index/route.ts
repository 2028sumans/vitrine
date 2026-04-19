/**
 * GET /api/category-index
 *
 * Returns a sample product image per display category for the /shop
 * category-picker grid. One Algolia search per category, run in parallel,
 * each pulling a single hit. Cached for an hour — the sample image can
 * rotate occasionally but doesn't need to be fresh on every visit.
 */

import { NextResponse }  from "next/server";
import { algoliasearch } from "algoliasearch";

export const revalidate = 3600; // 1 hour

const INDEX_NAME = "vitrine_products";

const CORE_CATS = ["dress", "top", "bottom", "jacket", "shoes", "bag"] as const;

type CategoryRequest = {
  label:    string;
  filters:  string | null;
  query:    string;
};

// Same mapping as app/api/shop-all/route.ts. Kept in sync manually — the two
// lanes need to agree on what each display label means.
const CATEGORIES: CategoryRequest[] = [
  { label: "Tops",                 filters: 'category:"top"',    query: "" },
  { label: "Dresses",              filters: 'category:"dress"',  query: "" },
  { label: "Bottoms",              filters: 'category:"bottom"', query: "" },
  { label: "Knits",                filters: null,                query: "knit sweater cardigan cashmere wool" },
  { label: "Bags and accessories", filters: 'category:"bag"',    query: "" },
  { label: "Shoes",                filters: 'category:"shoes"',  query: "" },
  { label: "Outerwear",            filters: 'category:"jacket"', query: "" },
  { label: "Other",                filters: CORE_CATS.map((c) => `NOT category:"${c}"`).join(" AND "), query: "" },
];

export async function GET() {
  const appId = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? "BSDU5QFOT3";
  const key   = process.env.ALGOLIA_SEARCH_KEY
    ?? process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_KEY
    ?? process.env.ALGOLIA_ADMIN_KEY;

  if (!appId || !key) {
    return NextResponse.json({ error: "Missing Algolia credentials" }, { status: 500 });
  }

  const client = algoliasearch(appId, key);

  const results = await Promise.all(
    CATEGORIES.map(async ({ label, filters, query }) => {
      try {
        const res = await client.searchSingleIndex({
          indexName: INDEX_NAME,
          searchParams: {
            query,
            ...(filters ? { filters } : {}),
            ...(query ? { optionalWords: query.split(/\s+/).filter(Boolean) } : {}),
            hitsPerPage: 1,
            attributesToRetrieve: ["objectID", "image_url"],
          },
        });
        const hit = res.hits?.[0] as { image_url?: string } | undefined;
        const imageUrl = typeof hit?.image_url === "string" && hit.image_url.startsWith("http") ? hit.image_url : null;
        return { label, imageUrl, count: res.nbHits ?? null };
      } catch (e) {
        console.warn(`[category-index] ${label} failed:`, e instanceof Error ? e.message : e);
        return { label, imageUrl: null, count: null };
      }
    }),
  );

  return NextResponse.json({ categories: results });
}
