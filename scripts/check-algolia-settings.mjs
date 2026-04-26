import "dotenv/config";
import { algoliasearch } from "algoliasearch";

const APP_ID    = process.env.ALGOLIA_APP_ID;
const ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX     = "vitrine_products";

const client = algoliasearch(APP_ID, ADMIN_KEY);
const settings = await client.getSettings({ indexName: INDEX });
console.log("searchableAttributes:");
console.log(JSON.stringify(settings.searchableAttributes ?? null, null, 2));
console.log("\nfacetingAttributes:");
console.log(JSON.stringify(settings.attributesForFaceting ?? null, null, 2));
console.log("\ncustomRanking:");
console.log(JSON.stringify(settings.customRanking ?? null, null, 2));
