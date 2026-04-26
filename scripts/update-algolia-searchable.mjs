/**
 * One-shot: bring title_en + description_en into Algolia's searchableAttributes
 * so non-English products with English back-fills (~2,730 already translated by
 * scripts/translate-non-english.mjs) actually surface for English queries.
 *
 * Pre-fix state: searchableAttributes was [title, brand, description, color,
 * material, aesthetic_tags, retailer, category]. title_en existed in the index
 * but Algolia wasn't searching against it — non-English titles were invisible
 * to English text queries even though we had the translation in storage.
 *
 * Post-fix: title and title_en are unordered (equal weight, either matches),
 * same for description / description_en. Brand stays ranked next, then the
 * rest. Outbound links still go to the native-language site; only the search
 * surface reads English.
 */
import "dotenv/config";
import { algoliasearch } from "algoliasearch";

const APP_ID    = process.env.ALGOLIA_APP_ID;
const ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX     = "vitrine_products";

const client = algoliasearch(APP_ID, ADMIN_KEY);

const NEW_SEARCHABLE = [
  "unordered(title,title_en)",
  "brand",
  "unordered(description,description_en)",
  "color",
  "material",
  "aesthetic_tags",
  "retailer",
  "category",
];

console.log("Setting searchableAttributes:");
console.log(JSON.stringify(NEW_SEARCHABLE, null, 2));

const res = await client.setSettings({
  indexName: INDEX,
  indexSettings: {
    searchableAttributes: NEW_SEARCHABLE,
  },
});

console.log("\n✓ Done. Algolia is reindexing in the background — non-English");
console.log("  products with title_en will start surfacing within a few minutes.");
console.log("  taskID:", res.taskID);
