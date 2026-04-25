import "dotenv/config";
import { algoliasearch } from "algoliasearch";

const APP_ID    = process.env.ALGOLIA_APP_ID;
const ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX     = "vitrine_products";

const client = algoliasearch(APP_ID, ADMIN_KEY);

const res = await client.searchSingleIndex({
  indexName: INDEX,
  searchParams: {
    facets:    ["category"],
    hitsPerPage: 0,
  },
});

console.log(JSON.stringify(res.facets?.category ?? {}, null, 2));
