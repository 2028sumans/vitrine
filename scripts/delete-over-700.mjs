/**
 * Delete every product priced over $700 from Algolia AND Pinecone.
 *
 * Pipeline:
 *   1. Browse Algolia for all rows where price > 700.
 *   2. Save full backup (objectID + title + brand + price) to
 *      scripts/deleted-over-700-backup-<timestamp>.json so we can
 *      reconstruct what was wiped if a regret kicks in. Backup is the
 *      first thing written; nothing is deleted until backup write succeeds.
 *   3. Show brand distribution + a 5-row sample for sanity.
 *   4. Delete from Algolia in 1000-ID batches via deleteObjects.
 *   5. Delete from Pinecone in 1000-ID batches via deleteMany (per
 *      namespace — taste / vibe / default all need to drop the IDs).
 *   6. Report counts.
 *
 * Run:
 *   node scripts/delete-over-700.mjs           # interactive confirm
 *   node scripts/delete-over-700.mjs --yes     # skip confirmation
 *   node scripts/delete-over-700.mjs --dry-run # preview only
 *
 * Env required: ALGOLIA_ADMIN_KEY, PINECONE_API_KEY (loaded from .env.local
 * automatically below).
 */

import { algoliasearch } from "algoliasearch";
import { Pinecone }      from "@pinecone-database/pinecone";
import { readFileSync, writeFileSync, existsSync } from "fs";
import readline from "readline";
import path from "path";

// Load .env.local if present so the script runs without explicit envs.
const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const PINECONE_API_KEY  = process.env.PINECONE_API_KEY;
const PINECONE_INDEX    = process.env.PINECONE_INDEX ?? "muse";
const ALGOLIA_INDEX     = "vitrine_products";

const PRICE_THRESHOLD = 700;
const DRY_RUN  = process.argv.includes("--dry-run");
const AUTO_YES = process.argv.includes("--yes");

if (!ALGOLIA_ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }
if (!PINECONE_API_KEY)  { console.error("Missing PINECONE_API_KEY");  process.exit(1); }

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}

async function main() {
  const algolia  = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);
  const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
  const pcIndex  = pinecone.index(PINECONE_INDEX);

  // ── Step 1: browse Algolia for the price > 700 set ───────────────────
  console.log(`Scanning Algolia for items with price > $${PRICE_THRESHOLD}…`);
  const matches = []; // { objectID, title, brand, price }
  await algolia.browseObjects({
    indexName: ALGOLIA_INDEX,
    browseParams: {
      query:                "",
      filters:              `price > ${PRICE_THRESHOLD}`,
      hitsPerPage:          1000,
      attributesToRetrieve: ["objectID", "title", "brand", "price"],
    },
    aggregator: (res) => {
      for (const hit of res.hits) {
        matches.push({
          objectID: hit.objectID,
          title:    hit.title ?? "",
          brand:    hit.brand ?? "",
          price:    hit.price ?? null,
        });
      }
      process.stdout.write(`\r  scanned ${matches.length}…`);
    },
  });
  console.log(`\n  Total matches: ${matches.length.toLocaleString()}\n`);

  if (matches.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  // ── Step 2: write backup BEFORE any destructive op ───────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const backupPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    `deleted-over-700-backup-${ts}.json`,
  );
  if (!DRY_RUN) {
    writeFileSync(
      backupPath,
      JSON.stringify({
        builtAt:        new Date().toISOString(),
        priceThreshold: PRICE_THRESHOLD,
        count:          matches.length,
        items:          matches,
      }, null, 2),
    );
    console.log(`Backup written: ${backupPath}\n`);
  }

  // ── Step 3: brand distribution + sample ──────────────────────────────
  const brandCounts = {};
  for (const m of matches) brandCounts[m.brand || "(unknown)"] = (brandCounts[m.brand || "(unknown)"] ?? 0) + 1;
  const topBrands = Object.entries(brandCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log("Top 10 brands being removed:");
  for (const [b, n] of topBrands) {
    console.log(`  ${b.padEnd(28)} ${n.toString().padStart(6)}`);
  }
  console.log(`\nSample of items being deleted:`);
  for (const m of matches.slice(0, 5)) {
    console.log(`  $${String(m.price).padStart(4)} | ${m.brand.padEnd(18)} | ${m.title.slice(0, 60)}`);
  }
  console.log("");

  if (DRY_RUN) {
    console.log("--dry-run: not deleting from Algolia or Pinecone.");
    return;
  }

  if (!AUTO_YES) {
    const a = await ask(`Delete these ${matches.length.toLocaleString()} from Algolia + Pinecone? Type "yes": `);
    if (a.trim().toLowerCase() !== "yes") { console.log("Cancelled."); return; }
  }

  // ── Step 4: delete from Algolia in batches of 1000 ───────────────────
  console.log("\nDeleting from Algolia…");
  const BATCH = 1000;
  let alDone = 0;
  for (let i = 0; i < matches.length; i += BATCH) {
    const batch = matches.slice(i, i + BATCH).map((m) => m.objectID);
    await algolia.deleteObjects({ indexName: ALGOLIA_INDEX, objectIDs: batch });
    alDone += batch.length;
    process.stdout.write(`\r  Algolia: ${alDone.toLocaleString()}/${matches.length.toLocaleString()}`);
  }
  console.log(`\n  ✓ Algolia done: ${alDone.toLocaleString()} records removed`);

  // ── Step 5: delete from Pinecone (every namespace) ───────────────────
  // Pinecone's deleteMany takes string IDs and is namespace-scoped. The
  // catalog has vectors in default + "vibe" + "taste" namespaces (vibe
  // for caption-based search, taste for projected-through-W vectors). We
  // hit all three so a deleted product can't reappear via any search lane.
  console.log("\nDeleting from Pinecone…");
  const stats = await pcIndex.describeIndexStats();
  const namespaces = Object.keys(stats.namespaces ?? { "": {} });

  for (const ns of namespaces) {
    const target = ns ? pcIndex.namespace(ns) : pcIndex;
    let pcDone = 0;
    for (let i = 0; i < matches.length; i += BATCH) {
      const ids = matches.slice(i, i + BATCH).map((m) => m.objectID);
      try {
        await target.deleteMany(ids);
        pcDone += ids.length;
      } catch (err) {
        console.error(`\n  ! ns="${ns || "(default)"}" batch ${i}-${i + ids.length} failed: ${err.message}`);
      }
      process.stdout.write(`\r  Pinecone ns="${ns || "(default)"}": ${pcDone.toLocaleString()}/${matches.length.toLocaleString()}`);
    }
    console.log("");
  }
  console.log("  ✓ Pinecone done");

  // ── Step 6: confirm new totals ────────────────────────────────────────
  console.log("\nVerifying…");
  const after = await algolia.searchSingleIndex({
    indexName:    ALGOLIA_INDEX,
    searchParams: { query: "", filters: `price > ${PRICE_THRESHOLD}`, hitsPerPage: 0 },
  });
  console.log(`  Algolia: ${after.nbHits.toLocaleString()} items still > $${PRICE_THRESHOLD} (expected 0)`);

  const totalAfter = await algolia.searchSingleIndex({
    indexName:    ALGOLIA_INDEX,
    searchParams: { query: "", hitsPerPage: 0 },
  });
  console.log(`  Algolia total: ${totalAfter.nbHits.toLocaleString()} products in catalog`);

  console.log(`\nBackup: ${backupPath}`);
  console.log(`Restore in emergency: re-upload via scripts/upload-checkpoint-to-algolia.mjs (Algolia)`);
  console.log(`+ scripts/embed-with-qc.mjs (Pinecone)`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
