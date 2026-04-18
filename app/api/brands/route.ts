/**
 * GET /api/brands
 *
 * Returns one entry per unique brand/retailer in the Algolia catalog, with
 * product count and a representative image URL. Cached for an hour at the
 * edge — regenerates the list on first request after the TTL. A full
 * catalog scan takes ~30-60s, so caching is worth it.
 */

import { NextResponse } from "next/server";
import { algoliasearch }  from "algoliasearch";

// Revalidate every hour. Changes to the catalog (adds, deletes) surface
// within this window on subsequent requests.
export const revalidate = 3600;

interface BrandEntry {
  name:      string;
  count:     number;
  imageUrl:  string | null;
}

export async function GET() {
  const appId = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID;
  const adminKey = process.env.ALGOLIA_ADMIN_KEY;

  if (!appId || !adminKey) {
    return NextResponse.json({ error: "Missing Algolia credentials" }, { status: 500 });
  }

  const client = algoliasearch(appId, adminKey);
  const brands = new Map<string, BrandEntry>();

  try {
    await client.browseObjects({
      indexName: "vitrine_products",
      browseParams: {
        query:                "",
        hitsPerPage:          1000,
        attributesToRetrieve: ["brand", "retailer", "image_url"],
      },
      aggregator: (res) => {
        for (const h of res.hits as Array<{ brand?: string; retailer?: string; image_url?: string }>) {
          const name = h.retailer || h.brand;
          if (!name) continue;
          const existing = brands.get(name);
          const img      = typeof h.image_url === "string" && h.image_url.startsWith("http") ? h.image_url : null;
          if (existing) {
            existing.count++;
            // Keep the first valid image we saw
            if (!existing.imageUrl && img) existing.imageUrl = img;
          } else {
            brands.set(name, { name, count: 1, imageUrl: img });
          }
        }
      },
    });

    const list = Array.from(brands.values()).sort((a, b) => b.count - a.count);
    return NextResponse.json({ brands: list, total: list.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[brands] browse failed:", message);
    return NextResponse.json({ error: "Failed to load brands", detail: message }, { status: 500 });
  }
}
