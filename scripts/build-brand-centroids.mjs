/**
 * Compute per-brand FashionCLIP centroids.
 *
 * For each distinct brand in the catalog, we sample up to N products, fetch
 * their vectors from Pinecone, average + normalize → one 512-dim vector per
 * brand. Output lands in lib/brand-centroids.json and is read at request
 * time by /api/brands/ordered to sort the /brands page by cosine-similarity
 * to the user's taste vector.
 *
 * Cost shape
 * ----------
 *   ~240 brands × up to 100 products per brand = ~24k Pinecone fetches in
 *   the worst case. Runs in ~2 min locally. Re-run when the catalog grows
 *   meaningfully (adding brands, re-embedding old stock).
 *
 * Usage
 * -----
 *   PINECONE_API_KEY=<k> ALGOLIA_ADMIN_KEY=<k> node scripts/build-brand-centroids.mjs
 *
 * Flags:
 *   --sample  N   items per brand (default 100). Diminishing returns past
 *                 50 — 100 is a safe ceiling for stability without bloating
 *                 the JSON.
 *   --out     p   output path (default lib/brand-centroids.json)
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
const PER_BRAND_LIMIT = Number(flag("sample", "100"));
const OUTPUT          = flag("out", "lib/brand-centroids.json");

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

// ── Step 1: browse the whole catalog, collect up to N products per brand ─────
// Browsing the full catalog once is cheaper than doing 240 individual
// brand-filtered queries. We cap per-brand during the scan so memory stays
// bounded even for brands with 10k+ products.

console.log(`Browsing Algolia catalog to collect up to ${PER_BRAND_LIMIT} IDs per brand…`);
const algolia = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

/** @type {Map<string, string[]>} brand → objectIDs (capped at PER_BRAND_LIMIT) */
const idsByBrand = new Map();

let scanned = 0;
await algolia.browseObjects({
  indexName: INDEX_NAME,
  browseParams: {
    query:                "",
    hitsPerPage:          1000,
    attributesToRetrieve: ["objectID", "brand", "retailer"],
  },
  aggregator: (res) => {
    for (const h of res.hits ?? []) {
      const brand = typeof h.brand === "string" && h.brand.trim()
        ? h.brand.trim()
        : (typeof h.retailer === "string" && h.retailer.trim() ? h.retailer.trim() : null);
      if (!brand) continue;
      const id = typeof h.objectID === "string" ? h.objectID : null;
      if (!id) continue;
      const bucket = idsByBrand.get(brand);
      if (!bucket) {
        idsByBrand.set(brand, [id]);
      } else if (bucket.length < PER_BRAND_LIMIT) {
        bucket.push(id);
      }
    }
    scanned += res.hits?.length ?? 0;
    process.stdout.write(`\r  scanned ${scanned}, ${idsByBrand.size} brands so far`);
  },
});
console.log();

const brandList = [...idsByBrand.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log(`\nCollected ${brandList.length} unique brands.`);

// ── Step 2: fetch vectors from Pinecone ──────────────────────────────────────

const allIds = new Set();
for (const ids of idsByBrand.values()) for (const id of ids) allIds.add(id);
console.log(`\nFetching ${allIds.size} vectors from Pinecone index "${PINECONE_INDEX}"…`);

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
    console.warn(`\n  fetch error (chunk ${i}):`, e.message);
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

// ── Step 3: average per brand, normalize ─────────────────────────────────────

function normalize(v) {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  return v.map((x) => x / n);
}

const centroids    = {};
const sampleCounts = {};
for (const [brand, ids] of brandList) {
  const vectors = ids.map((id) => vecById.get(id)).filter(Boolean);
  sampleCounts[brand] = vectors.length;
  if (vectors.length === 0) { centroids[brand] = null; continue; }
  const sum = new Array(DIM).fill(0);
  for (const v of vectors) {
    const nv = normalize(v);
    for (let i = 0; i < DIM; i++) sum[i] += nv[i];
  }
  const avg = sum.map((s) => s / vectors.length);
  centroids[brand] = normalize(avg);
}

// ── Step 4: write ────────────────────────────────────────────────────────────

const payload = {
  version:      1,
  dim:          DIM,
  builtAt:      new Date().toISOString(),
  sampleCounts,
  centroids,
};

writeFileSync(OUTPUT, JSON.stringify(payload) + "\n");  // minified — this file is big
const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1);
console.log(`\n✓ Wrote ${Object.keys(centroids).length} brand centroids (${DIM}-dim) to ${OUTPUT} (${kb} KB)`);

const empty = brandList.filter(([b]) => centroids[b] == null).map(([b]) => b);
if (empty.length) {
  console.warn(`\n⚠ ${empty.length} brands have no centroid (no vectors returned). They'll sort at the bottom of the taste-ranked /brands page.`);
}
