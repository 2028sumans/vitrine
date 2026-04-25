/**
 * Looks up the 10 IDs FashionCLIP returned for "y2k party" in Algolia
 * and prints their brand, title, and category. Tells us whether the
 * encoder is finding genuinely-y2k items (in which case the UI/RRF
 * layer is hiding them) or junk (in which case the embedding space
 * itself isn't separating y2k well).
 */
import "dotenv/config";
import { algoliasearch } from "algoliasearch";

const APP_ID  = process.env.ALGOLIA_APP_ID;
const API_KEY = process.env.ALGOLIA_ADMIN_KEY ?? process.env.ALGOLIA_SEARCH_KEY;
const INDEX   = process.env.ALGOLIA_INDEX ?? "vitrine_products";

const ids = [
  "shpfy-politesocietycom-9074509644062",
  "shpfy-ava-becom-15957330657615",
  "shpfy-coucouintimatescom-7796506656946",
  "shpfy-dippindaisyscom-8218063863979",
  "shpfy-yumeyumeeu-8484444340560",
];

const client = algoliasearch(APP_ID, API_KEY);
const { results } = await client.getObjects({
  requests: ids.map((objectID) => ({ indexName: INDEX, objectID })),
});

console.log("── Top 5 FashionCLIP neighbours for 'y2k party' ─────────────\n");
for (const r of results) {
  if (!r) {
    console.log("  ✗ NOT FOUND in Algolia (Pinecone-only ghost)");
    continue;
  }
  console.log(`  ${r.brand ?? "?"}  ·  ${r.title ?? r.name ?? "?"}`);
  console.log(`    cat: ${r.category ?? r.gender ?? "?"}  |  url: ${r.url ?? r.product_url ?? "?"}`);
  console.log(`    img: ${(r.image ?? r.image_url ?? "").slice(0, 100)}`);
  console.log();
}
