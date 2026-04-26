/**
 * Pinecone-only follow-up to delete-over-700.mjs.
 *
 * The first run got Algolia (eventually consistent — verified at 0 hits
 * for price > 700) but Pinecone failed with "Invalid request" because I
 * passed the IDs as a raw array (`deleteMany([...])`) instead of the
 * object form (`deleteMany({ ids: [...] })`) that the @pinecone-database
 * client actually expects. The existing scripts/delete-camilla-babies-
 * pinecone.mjs has the working pattern; this script copies it.
 *
 * Reads the backup JSON dropped by delete-over-700.mjs to get the exact
 * list of objectIDs that were removed from Algolia, then deletes them
 * from every Pinecone namespace (default + vibe + taste).
 *
 * Run:
 *   node scripts/delete-over-700-pinecone-only.mjs <backup-file>
 *   (defaults to the most recent deleted-over-700-backup-*.json if no arg)
 */

import { Pinecone } from "@pinecone-database/pinecone";
import { readFileSync, existsSync, readdirSync } from "fs";
import path from "path";

const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) {
      const [, k, raw] = m;
      const v = raw.replace(/^["']|["']$/g, "");
      // Skip the malformed PINECONE_INDEX entry the older scripts warn about.
      if (k === "PINECONE_INDEX" && /[=\s]/.test(v)) continue;
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX   = process.env.PINECONE_INDEX ?? "muse";
if (!PINECONE_API_KEY) { console.error("Missing PINECONE_API_KEY"); process.exit(1); }

// Resolve backup file: explicit arg, else newest matching filename.
const scriptsDir = path.dirname(new URL(import.meta.url).pathname);
let backupFile = process.argv[2];
if (!backupFile) {
  const candidates = readdirSync(scriptsDir)
    .filter((f) => f.startsWith("deleted-over-700-backup-") && f.endsWith(".json"))
    .sort()
    .reverse();
  if (candidates.length === 0) {
    console.error(`No backup file found in ${scriptsDir} (expected deleted-over-700-backup-*.json)`);
    process.exit(1);
  }
  backupFile = path.join(scriptsDir, candidates[0]);
} else if (!path.isAbsolute(backupFile)) {
  backupFile = path.join(scriptsDir, backupFile);
}

console.log(`Backup file: ${backupFile}`);
const backup = JSON.parse(readFileSync(backupFile, "utf8"));
const ids = (backup.items ?? []).map((it) => it.objectID).filter(Boolean);
console.log(`IDs to delete: ${ids.length.toLocaleString()}\n`);

if (ids.length === 0) {
  console.log("Nothing to delete.");
  process.exit(0);
}

const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
const pcIndex  = pinecone.index(PINECONE_INDEX);

const stats = await pcIndex.describeIndexStats();
const namespaces = Object.keys(stats.namespaces ?? { __default__: {} });
console.log(`Namespaces in index: ${namespaces.join(", ")}\n`);

const BATCH = 1000;
for (const ns of namespaces) {
  // Pinecone's "default" namespace is named "__default__" in the API
  // when listed via stats. Empty string vs "__default__" both work for
  // the .namespace() call but the loop key matches stats output.
  const target = pcIndex.namespace(ns);
  let done = 0, errors = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    try {
      // Object form { ids: [...] } — the array form throws "Invalid request"
      // on this SDK version. Pattern matches scripts/delete-camilla-babies-pinecone.mjs
      // which is the known-working delete pattern in this repo.
      await target.deleteMany({ ids: batch });
      done += batch.length;
    } catch (err) {
      errors++;
      console.warn(`\n  ⚠ ns="${ns}" batch ${i}-${i + batch.length}: ${err.message}`);
    }
    process.stdout.write(`\r  ns="${ns}": ${done.toLocaleString()}/${ids.length.toLocaleString()}${errors ? ` (${errors} errors)` : ""}`);
  }
  console.log("");
}

// Verify: query each namespace stats again, see total drop.
console.log("\nVerifying…");
const after = await pcIndex.describeIndexStats();
console.log(`  Total vectors after delete:`);
for (const [ns, info] of Object.entries(after.namespaces ?? {})) {
  const before = stats.namespaces?.[ns]?.recordCount ?? stats.namespaces?.[ns]?.vectorCount ?? 0;
  const nowN   = info.recordCount ?? info.vectorCount ?? 0;
  console.log(`    ${ns}: ${nowN.toLocaleString()} (was ${before.toLocaleString()}, diff ${(nowN - before).toLocaleString()})`);
}
console.log("\n✓ Done.");
