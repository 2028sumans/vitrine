/**
 * Flip the `vitrine_products` index into NeuralSearch mode.
 *
 * Why this script: Algolia's `mode` is a SETTINGS-scoped parameter
 * (algolia.com/doc/api-reference/settings/mode). It can only be set on the
 * index itself via `setSettings`, never per-query. The dashboard has a
 * point-and-click toggle for this (Indices → vitrine_products → Configuration
 * → AI tab → Enable NeuralSearch); this script is the API equivalent for
 * scripted bring-up or rollback.
 *
 * Pre-requisites:
 *   - Your plan includes NeuralSearch (the "expensive tier" you mentioned).
 *   - The catalog has finished its neural re-indexing pass. The dashboard
 *     shows progress; on a 121k-item catalog the first build takes ~30-60 min.
 *     Re-running this script before re-indexing finishes is a no-op — the
 *     mode flips, but Algolia waits for vectors to be ready before applying.
 *
 * Usage:
 *   node scripts/enable-neural-search.mjs            # flip to neural
 *   node scripts/enable-neural-search.mjs --revert   # flip back to keyword
 *   node scripts/enable-neural-search.mjs --check    # report current mode, exit
 *
 * Verification after running:
 *   curl -s -X POST "https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/vitrine_products/query" \
 *     -H "X-Algolia-API-Key: $ALGOLIA_ADMIN_KEY" \
 *     -H "X-Algolia-Application-Id: $ALGOLIA_APP_ID" \
 *     -H "Content-Type: application/json" \
 *     -d '{"query":"more dad-core minimalist","hitsPerPage":3,"getRankingInfo":true}' | head -c 1000
 *
 *   When neural is live the response includes `_rankingInfo.neuralScore`
 *   on each hit, and the abstract "dad-core" query returns real items
 *   instead of zero hits.
 */

import { algoliasearch } from "algoliasearch";
import { readFileSync, existsSync } from "fs";
import path from "path";

const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX_NAME        = "vitrine_products";

if (!ALGOLIA_ADMIN_KEY) {
  console.error("✗ Missing ALGOLIA_ADMIN_KEY — set it in .env.local or the environment.");
  process.exit(1);
}

const args   = process.argv.slice(2);
const REVERT = args.includes("--revert");
const CHECK  = args.includes("--check");

const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

async function getCurrentMode() {
  const settings = await client.getSettings({ indexName: INDEX_NAME });
  return settings.mode ?? "(unset → defaults to keywordSearch)";
}

if (CHECK) {
  const mode = await getCurrentMode();
  console.log(`Current mode for ${INDEX_NAME}: ${mode}`);
  process.exit(0);
}

const target = REVERT ? "keywordSearch" : "neuralSearch";
console.log(`Setting ${INDEX_NAME}.mode = "${target}" …`);

try {
  const before = await getCurrentMode();
  console.log(`  before: ${before}`);
  await client.setSettings({
    indexName:     INDEX_NAME,
    indexSettings: { mode: target },
  });
  const after = await getCurrentMode();
  console.log(`  after:  ${after}`);
  console.log(`✓ Done. ${target === "neuralSearch"
    ? "Algolia is re-ranking with vector + keyword from this point on. Verify with the curl in the file header."
    : "Index reverted to pure keyword search."}`);
} catch (err) {
  console.error("✗ setSettings failed:", err instanceof Error ? err.message : err);
  if (String(err).includes("Unknown")) {
    console.error("  Likely cause: NeuralSearch isn't enabled on your plan / index. Check the dashboard's AI tab first.");
  }
  process.exit(1);
}
