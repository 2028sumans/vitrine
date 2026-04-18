/**
 * Delete specific product(s) from Algolia + Pinecone by search query.
 *
 * Run:
 *   ALGOLIA_ADMIN_KEY=<key> PINECONE_API_KEY=<key> \
 *     node scripts/delete-product-by-query.mjs "I Am Gia Fafi"
 *
 * Flags:
 *   --yes      skip confirmation
 *   --dry-run  preview matches, don't delete
 */

import { algoliasearch } from "algoliasearch";
import readline from "readline";

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const PINECONE_API_KEY  = process.env.PINECONE_API_KEY;
const PINECONE_INDEX    = process.env.PINECONE_INDEX ?? "muse";
const INDEX_NAME        = "vitrine_products";

const DRY_RUN  = process.argv.includes("--dry-run");
const AUTO_YES = process.argv.includes("--yes");

// Modes:
//   Query mode: pass a search string, e.g. "Muslim Breakfast Club"
//   ID mode:    pass --ids=id1,id2,id3 for exact-objectID targeting
const idsFlag = process.argv.find((a) => a.startsWith("--ids="));
const explicitIds = idsFlag ? idsFlag.slice(6).split(",").map((s) => s.trim()).filter(Boolean) : [];

const query = process.argv.slice(2)
  .filter((a) => !a.startsWith("--"))
  .join(" ")
  .trim();

if (!query && explicitIds.length === 0) {
  console.error("Usage: node scripts/delete-product-by-query.mjs \"<query>\"  or  --ids=id1,id2");
  process.exit(1);
}
if (!ALGOLIA_ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}

async function main() {
  const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

  let objectIDs = [];
  if (explicitIds.length > 0) {
    console.log(`Explicit IDs: ${explicitIds.join(", ")}\n`);
    // Fetch each to confirm what we're deleting
    const fetched = await client.getObjects({
      requests: explicitIds.map((id) => ({ indexName: INDEX_NAME, objectID: id })),
    });
    const hits = (fetched.results ?? []).filter((r) => r != null);
    if (hits.length === 0) { console.log("No records found for those IDs."); return; }
    hits.forEach((h, i) => {
      const price = h.price ? `$${Math.round(h.price)}` : "—";
      console.log(`  ${i + 1}. [${h.objectID}]  ${h.brand ?? "?"} — ${h.title ?? "?"}  (${price}, ${h.retailer ?? "?"})`);
    });
    objectIDs = hits.map((h) => h.objectID);
  } else {
    console.log(`Searching Algolia for: "${query}"\n`);
    const res = await client.searchSingleIndex({
      indexName: INDEX_NAME,
      searchParams: {
        query,
        hitsPerPage: 1000,
        attributesToRetrieve: ["objectID", "title", "brand", "image_url", "price", "retailer"],
      },
    });

    const hits = res.hits ?? [];
    if (hits.length === 0) { console.log("No matches. Nothing to delete."); return; }
    console.log(`Found ${hits.length} match${hits.length === 1 ? "" : "es"}:\n`);
    hits.forEach((h, i) => {
      const price = h.price ? `$${Math.round(h.price)}` : "—";
      console.log(`  ${i + 1}. [${h.objectID}]  ${h.brand ?? "?"} — ${h.title ?? "?"}  (${price}, ${h.retailer ?? "?"})`);
    });
    objectIDs = hits.map((h) => h.objectID);
  }

  if (DRY_RUN) {
    console.log("\n--dry-run: not deleting. Re-run without --dry-run to delete.");
    return;
  }

  if (!AUTO_YES) {
    const a = await ask(`\nDelete all ${objectIDs.length} from Algolia AND Pinecone? Type "yes": `);
    if (a.trim().toLowerCase() !== "yes") { console.log("Cancelled."); return; }
  }

  // Delete from Algolia
  console.log("\nDeleting from Algolia…");
  await client.deleteObjects({ indexName: INDEX_NAME, objectIDs });
  console.log(`✓ Algolia: deleted ${objectIDs.length} records`);

  // Delete from Pinecone (if key provided)
  if (PINECONE_API_KEY) {
    console.log("\nDeleting from Pinecone…");
    const { Pinecone } = await import("@pinecone-database/pinecone");
    const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
    const index = pc.index(PINECONE_INDEX);
    try {
      // SDK v7: use { ids: [...] } object form; default namespace is "__default__"
      await index.namespace("__default__").deleteMany({ ids: objectIDs });
      console.log(`✓ Pinecone: deleted ${objectIDs.length} vectors`);
    } catch (e) {
      console.warn(`⚠ Pinecone delete failed (non-fatal): ${e.message}`);
    }
  } else {
    console.log("\n(Skipped Pinecone — set PINECONE_API_KEY to delete vectors too.)");
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
