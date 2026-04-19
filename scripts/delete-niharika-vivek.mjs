/**
 * Delete every Niharika Vivek record from Algolia (the user catalog) AND
 * Pinecone (both the default and `vibe` namespaces, which is where the
 * visual + caption embeddings live).
 *
 * Run:
 *   ALGOLIA_ADMIN_KEY=… PINECONE_API_KEY=… node scripts/delete-niharika-vivek.mjs
 *   Add --yes to skip the confirm prompt.
 *   Add --dry-run to count without deleting.
 *
 * Matches the Needledust / Camilla Babies deletion pattern already in
 * this directory — Algolia browse to collect IDs, then a batched
 * deleteMany against Pinecone in every namespace.
 */

import { algoliasearch } from "algoliasearch";
import { Pinecone }      from "@pinecone-database/pinecone";
import fs                from "fs";
import path              from "path";
import readline          from "readline";

// Pull in .env.local so this runs with a plain `node scripts/…`.
const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) {
      const [, k, raw] = m;
      const v = raw.replace(/^["']|["']$/g, "");
      if (k === "PINECONE_INDEX" && /[=\s]/.test(v)) continue;
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const PINECONE_API_KEY  = process.env.PINECONE_API_KEY;
const PINECONE_INDEX    = process.env.PINECONE_INDEX ?? "muse";
const INDEX_NAME        = "vitrine_products";
const DRY_RUN           = process.argv.includes("--dry-run");
const AUTO_YES          = process.argv.includes("--yes");

// Niharika Vivek has been spelled a couple of ways in various scrapes;
// match all the variants case-insensitively.
const BRAND_MATCH = ["niharika vivek", "niharikavivek", "niharika-vivek"];

if (!ALGOLIA_ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }
if (!PINECONE_API_KEY)  { console.error("Missing PINECONE_API_KEY");  process.exit(1); }

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}

function matchesBrand(hit) {
  const b = (hit.brand    ?? "").toLowerCase().replace(/\s+/g, "");
  const r = (hit.retailer ?? "").toLowerCase().replace(/\s+/g, "");
  const targets = BRAND_MATCH.map((t) => t.toLowerCase().replace(/\s+/g, ""));
  return targets.some((t) => b === t || r === t);
}

async function main() {
  console.log(`Target brand: Niharika Vivek (case-insensitive, variants: ${BRAND_MATCH.join(", ")})`);
  console.log(`Algolia index: ${INDEX_NAME}`);
  console.log(`Pinecone index: ${PINECONE_INDEX} (namespaces: __default__, vibe)`);
  console.log("");

  // ── Step 1. Collect object IDs via Algolia browse ──────────────────────
  const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);
  console.log("Scanning Algolia for matching records…");
  const ids = [];
  await client.browseObjects({
    indexName: INDEX_NAME,
    browseParams: {
      query: "",
      hitsPerPage: 1000,
      attributesToRetrieve: ["objectID", "brand", "retailer"],
    },
    aggregator: (res) => {
      for (const hit of res.hits) {
        if (matchesBrand(hit)) ids.push(hit.objectID);
      }
      process.stdout.write(`\r  scanning… ${ids.length} matches so far`);
    },
  });
  console.log(`\n  Total matched: ${ids.length.toLocaleString()}\n`);

  if (ids.length === 0) {
    console.log("Nothing to delete. Exiting.");
    return;
  }

  if (DRY_RUN) {
    console.log("[dry run] Would delete the IDs above. No changes made.");
    return;
  }

  if (!AUTO_YES) {
    const answer = await ask(`Delete ${ids.length} records from Algolia AND Pinecone? [y/N] `);
    if (answer.trim().toLowerCase() !== "y") { console.log("Aborted."); return; }
  }

  // ── Step 2. Delete from Algolia ────────────────────────────────────────
  console.log("Deleting from Algolia…");
  const BATCH = 1000;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    await client.deleteObjects({ indexName: INDEX_NAME, objectIDs: batch });
    console.log(`  algolia: ${Math.min(i + BATCH, ids.length).toLocaleString()} / ${ids.length.toLocaleString()}`);
  }
  console.log("  ✓ Algolia done.\n");

  // ── Step 3. Delete from Pinecone (both namespaces) ─────────────────────
  console.log("Deleting from Pinecone…");
  const pc    = new Pinecone({ apiKey: PINECONE_API_KEY });
  const index = pc.index(PINECONE_INDEX);
  for (const nsName of ["__default__", "vibe"]) {
    const ns = index.namespace(nsName);
    let done = 0, errors = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      try {
        await ns.deleteMany({ ids: batch });
        done += batch.length;
      } catch (e) {
        errors++;
        console.warn(`  ⚠ ${nsName} batch ${i}: ${e.message}`);
      }
    }
    console.log(`  pinecone/${nsName}: ${done.toLocaleString()} ids processed (${errors} batch errors)`);
  }
  console.log("  ✓ Pinecone done.\n");
  console.log("All done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
