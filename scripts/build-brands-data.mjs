/**
 * Build-time generator for the Brands page data.
 *
 * Browses the entire Algolia catalog (requires ALGOLIA_ADMIN_KEY), aggregates
 * unique retailer/brand names + product counts + a representative image URL
 * per brand, and writes the result as static JSON to app/brands/brands.json.
 *
 * The /brands page imports this JSON directly — no runtime API call, no
 * serverless function timeout, no Algolia faceting config required.
 *
 * Re-run whenever the catalog changes meaningfully:
 *   ALGOLIA_ADMIN_KEY=... node scripts/build-brands-data.mjs
 *   # then commit the updated app/brands/brands.json
 */

import { algoliasearch } from "algoliasearch";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX_NAME        = "vitrine_products";
const OUT_PATH          = "app/brands/brands.json";

if (!ALGOLIA_ADMIN_KEY) {
  console.error("Missing ALGOLIA_ADMIN_KEY. Source .env.local first.");
  process.exit(1);
}

const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);
const brands = new Map();
let scanned = 0;

console.log("Browsing Algolia catalog…");
await client.browseObjects({
  indexName: INDEX_NAME,
  browseParams: {
    query: "",
    hitsPerPage: 1000,
    attributesToRetrieve: ["brand", "retailer", "image_url"],
  },
  aggregator: (res) => {
    for (const h of res.hits) {
      const name = h.retailer || h.brand;
      if (!name) continue;
      const existing = brands.get(name);
      const img = typeof h.image_url === "string" && h.image_url.startsWith("http") ? h.image_url : null;
      if (existing) {
        existing.count++;
        if (!existing.imageUrl && img) existing.imageUrl = img;
      } else {
        brands.set(name, { name, count: 1, imageUrl: img });
      }
    }
    scanned += res.hits.length;
    process.stdout.write(`\r  scanned ${scanned.toLocaleString()} / ${brands.size} unique brands`);
  },
});

const list = Array.from(brands.values()).sort((a, b) => b.count - a.count);
console.log(`\n\n✓ ${list.length} unique brands across ${scanned.toLocaleString()} products`);

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(),
  totalProducts: scanned,
  totalBrands: list.length,
  brands: list,
}, null, 2));
console.log(`✓ Wrote ${OUT_PATH}`);
