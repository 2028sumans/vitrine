/**
 * Auto-derive per-style FashionCLIP centroids from the catalog's existing
 * `aesthetic_tags` field — no manual labeling required.
 *
 * The catalog already carries per-product aesthetic tags written by the
 * scrape/embed pipeline. For each known aesthetic, we:
 *
 *   1. Query Algolia for products with that tag, capped at `sampleLimit`.
 *   2. Fetch each product's 512-dim vector from Pinecone.
 *   3. Average, normalize → per-aesthetic centroid.
 *   4. Write to lib/style-centroids.json.
 *
 * At ~500 products/aesthetic, the centroid is far more stable than anything
 * hand-labeling can produce at a realistic scale — and it costs zero manual
 * effort.
 *
 * Downstream: lib/taste-profile.ts can blend a user's preferred styles
 * (from a future quiz step or inferred from their upload centroid's nearest
 * style neighbour) as a third composition source alongside age + uploads.
 * For now this file is produced but not yet consumed — wiring it into
 * taste-profile is a follow-up.
 *
 * Usage
 * -----
 *   PINECONE_API_KEY=<key> ALGOLIA_ADMIN_KEY=<key> node scripts/build-style-centroids.mjs
 *
 * Flags:
 *   --sample  N   items per aesthetic to sample (default 500)
 *   --out     p   output path (default lib/style-centroids.json)
 */

import { algoliasearch } from "algoliasearch";
import { Pinecone } from "@pinecone-database/pinecone";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

// ── Flags + env ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return (v == null || v.startsWith("--")) ? fallback : v;
}
const SAMPLE_LIMIT = Number(flag("sample", "500"));
const OUTPUT       = flag("out", "lib/style-centroids.json");

// Load .env.local lightly so the script runs without `set -a && source …`.
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
const INDEX_NAME        = "vitrine_products";

if (!ALGOLIA_ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }
if (!PINECONE_API_KEY)  { console.error("Missing PINECONE_API_KEY");  process.exit(1); }

// Mirror of KNOWN_AESTHETICS in app/api/shop-all/route.ts. Keep in sync if
// new aesthetics are added to the catalog.
const KNOWN_AESTHETICS = [
  "minimalist", "bohemian", "romantic", "edgy", "preppy", "casual",
  "elegant", "sporty", "cottagecore", "party", "y2k", "coastal",
];

// ── Step 1: collect per-aesthetic objectIDs from Algolia ─────────────────────

console.log(`Querying Algolia (index: ${INDEX_NAME}) for up to ${SAMPLE_LIMIT} items per aesthetic…\n`);
const algolia = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

/** @type {Map<string, string[]>} aesthetic → objectIDs */
const idsByAesthetic = new Map();

for (const aesthetic of KNOWN_AESTHETICS) {
  const ids = [];
  // browseObjects paginates through the full result set for a filter.
  // `aesthetic_tags` must be configured as attributesForFaceting filterable
  // in the index settings (it is — filters like `aesthetic_tags:"minimalist"`
  // work across the catalog).
  try {
    await algolia.browseObjects({
      indexName: INDEX_NAME,
      browseParams: {
        query:               "",
        filters:             `aesthetic_tags:"${aesthetic}"`,
        hitsPerPage:         1000,
        attributesToRetrieve: ["objectID"],
      },
      aggregator: (res) => {
        for (const h of res.hits ?? []) {
          if (typeof h.objectID === "string" && ids.length < SAMPLE_LIMIT) {
            ids.push(h.objectID);
          }
        }
      },
    });
  } catch (e) {
    console.warn(`  ${aesthetic.padEnd(14)} Algolia error: ${e instanceof Error ? e.message : e}`);
  }
  idsByAesthetic.set(aesthetic, ids);
  console.log(`  ${aesthetic.padEnd(14)} ${String(ids.length).padStart(4)} items`);
}

const totalIds = [...idsByAesthetic.values()].reduce((n, a) => n + a.length, 0);
console.log(`\nTotal: ${totalIds} IDs across ${KNOWN_AESTHETICS.length} aesthetics.`);

// ── Step 2: fetch vectors from Pinecone ──────────────────────────────────────
// Dedupe first — many products carry multiple aesthetic_tags, no need to
// fetch the same vector twice.

const allIds = new Set();
for (const ids of idsByAesthetic.values()) for (const id of ids) allIds.add(id);

console.log(`\nFetching ${allIds.size} unique vectors from Pinecone index "${PINECONE_INDEX}"…`);
const pc    = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = pc.index(PINECONE_INDEX);
const vecById = new Map();
const idList  = Array.from(allIds);
const CHUNK   = 100;
for (let i = 0; i < idList.length; i += CHUNK) {
  const chunk = idList.slice(i, i + CHUNK);
  try {
    const res = await index.fetch({ ids: chunk });
    if (res?.records) {
      for (const [id, rec] of Object.entries(res.records)) {
        if (rec?.values?.length) vecById.set(id, Array.from(rec.values));
      }
    }
  } catch (e) {
    console.warn(`  Pinecone fetch error (chunk ${i}):`, e.message);
  }
  process.stdout.write(`\r  ${Math.min(i + CHUNK, idList.length)}/${idList.length} queried, ${vecById.size} hit`);
}
console.log();

if (vecById.size === 0) {
  console.error("✗ No vectors returned — cannot build centroids.");
  process.exit(1);
}
const DIM = vecById.values().next().value.length;
console.log(`  vector dim = ${DIM}`);

// ── Step 3: average + normalize ──────────────────────────────────────────────

function normalize(v) {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  return v.map((x) => x / n);
}

const centroids    = {};
const sampleCounts = {};
for (const aesthetic of KNOWN_AESTHETICS) {
  const ids     = idsByAesthetic.get(aesthetic) ?? [];
  const vectors = ids.map((id) => vecById.get(id)).filter(Boolean);
  sampleCounts[aesthetic] = vectors.length;
  if (vectors.length === 0) { centroids[aesthetic] = null; continue; }

  const sum = new Array(DIM).fill(0);
  for (const v of vectors) {
    const nv = normalize(v);
    for (let i = 0; i < DIM; i++) sum[i] += nv[i];
  }
  const avg = sum.map((s) => s / vectors.length);
  centroids[aesthetic] = normalize(avg);
}

// ── Step 4: write ────────────────────────────────────────────────────────────

const payload = {
  version:      1,
  dim:          DIM,
  builtAt:      new Date().toISOString(),
  sampleCounts,
  centroids,
};

writeFileSync(OUTPUT, JSON.stringify(payload, null, 2) + "\n");
const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1);
console.log(`\n✓ Wrote ${Object.keys(centroids).length} style centroids (${DIM}-dim) to ${OUTPUT} (${kb} KB)`);

const empty = KNOWN_AESTHETICS.filter((a) => centroids[a] == null);
if (empty.length) {
  console.warn(`\n⚠ Empty centroids (no hits): ${empty.join(", ")}`);
}
