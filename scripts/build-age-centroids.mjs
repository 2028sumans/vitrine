/**
 * Compute per-category × per-age FashionCLIP centroids from the hand-labeled
 * eval sets, output to a single nested lib/age-centroids.json.
 *
 * Pipeline
 * --------
 *   1. Read every data/eval-set-<category>.jsonl that exists.
 *   2. For each (category, age-bucket) pair, collect kept_ids → fetch
 *      vectors from Pinecone → average → unit-normalize.
 *   3. Write a single file with shape:
 *        { version, dim, builtAt, perCategory: {
 *            tops:    { sampleCounts, centroids: { age-13-18: [...], … } },
 *            shoes:   { … },
 *            ...
 *          } }
 *
 * Categories without an eval-set file land with all-null centroids in the
 * output — lib/taste-profile.ts treats null as "no signal" so missing
 * categories cause graceful zero-impact, not errors.
 *
 * Usage
 * -----
 *   PINECONE_API_KEY=<k> node scripts/build-age-centroids.mjs
 *   PINECONE_API_KEY=<k> node scripts/build-age-centroids.mjs --category shoes
 *
 * Re-runs are idempotent — the output file is rewritten each time.
 */

import { Pinecone } from "@pinecone-database/pinecone";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Flags + env ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return (v == null || v.startsWith("--")) ? fallback : v;
}
const ONLY_CATEGORY = flag("category", null);
const OUTPUT        = flag("out", "lib/age-centroids.json");
const MIN           = Number(flag("min", "20"));

const envPath = path.resolve(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX   = process.env.PINECONE_INDEX ?? "muse";
if (!PINECONE_API_KEY) { console.error("Missing PINECONE_API_KEY"); process.exit(1); }

// Mirrors lib/category-taxonomy.ts. Update both lists if you add a category.
const CATEGORY_SLUGS = [
  "tops", "dresses", "bottoms", "knits", "outerwear",
  "shoes", "bags-and-accessories",
];
const AGE_KEYS = ["age-13-18", "age-18-25", "age-25-32", "age-32-40", "age-40-60"];
const DATA_DIR = path.resolve(__dirname, "..", "data");

const slugsToProcess = ONLY_CATEGORY
  ? (CATEGORY_SLUGS.includes(ONLY_CATEGORY) ? [ONLY_CATEGORY] : [])
  : CATEGORY_SLUGS;

if (ONLY_CATEGORY && slugsToProcess.length === 0) {
  console.error(`✗ Unknown category: ${ONLY_CATEGORY}`);
  process.exit(1);
}

// ── Step 1: per-category, collect kept_ids by age bucket from the JSONL ──────

/** category-slug → age-key → [objectID, ...] */
const idsByCategoryAge = new Map();

for (const slug of slugsToProcess) {
  const evalSet = path.join(DATA_DIR, `eval-set-${slug}.jsonl`);
  if (!existsSync(evalSet)) {
    console.log(`[${slug.padEnd(22)}] no eval-set file — centroids will be null`);
    continue;
  }

  const rows = readFileSync(evalSet, "utf8")
    .split("\n").map((s) => s.trim()).filter(Boolean)
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);

  const ageMap = new Map();
  for (const r of rows) {
    // dna_hash format: "eval:<slug>:age-NN-NN"
    const m = String(r.dna_hash ?? "").match(/^eval:[^:]+:(age-[\d-]+)$/);
    if (!m) continue;
    const ageKey = m[1];
    if (!ageMap.has(ageKey)) ageMap.set(ageKey, []);
    ageMap.get(ageKey).push(...(r.kept_ids ?? []));
  }
  idsByCategoryAge.set(slug, ageMap);

  const totalIds = [...ageMap.values()].reduce((n, a) => n + a.length, 0);
  console.log(`[${slug.padEnd(22)}] ${totalIds} kept-ids across ${ageMap.size} buckets`);
}

// ── Step 2: collect ALL unique objectIDs and fetch their vectors once ────────
// Many products are tagged across multiple categories (a sweater that's
// labeled in both "knits" and "tops") — fetching once and caching the
// vector is much faster than per-category fetches.

const allIds = new Set();
for (const ageMap of idsByCategoryAge.values()) {
  for (const ids of ageMap.values()) for (const id of ids) allIds.add(id);
}

console.log(`\nFetching ${allIds.size} unique vectors from Pinecone "${PINECONE_INDEX}"…`);
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

const DIM = vecById.size > 0 ? vecById.values().next().value.length : 512;
console.log(`  vector dim = ${DIM}`);

// ── Step 3: average + normalize per (category, age) ──────────────────────────

function normalize(v) {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  return v.map((x) => x / n);
}

// If we're updating only one category, preserve the existing other-category
// data from the previous build instead of nulling them out.
let existing = null;
if (ONLY_CATEGORY && existsSync(OUTPUT)) {
  try { existing = JSON.parse(readFileSync(OUTPUT, "utf8")); } catch { /* ignore */ }
}

const perCategory = {};
for (const slug of CATEGORY_SLUGS) {
  // Carry over previously-built data when we're scoped to a single category
  // and this isn't the one we're rebuilding.
  if (ONLY_CATEGORY && slug !== ONLY_CATEGORY && existing?.perCategory?.[slug]) {
    perCategory[slug] = existing.perCategory[slug];
    continue;
  }

  const ageMap        = idsByCategoryAge.get(slug);
  const sampleCounts  = {};
  const centroids     = {};

  for (const ageKey of AGE_KEYS) {
    const ids     = ageMap?.get(ageKey) ?? [];
    const vectors = ids.map((id) => vecById.get(id)).filter(Boolean);
    sampleCounts[ageKey] = vectors.length;
    if (vectors.length === 0) { centroids[ageKey] = null; continue; }
    const sum = new Array(DIM).fill(0);
    for (const v of vectors) {
      const nv = normalize(v);
      for (let i = 0; i < DIM; i++) sum[i] += nv[i];
    }
    const avg = sum.map((s) => s / vectors.length);
    centroids[ageKey] = normalize(avg);

    if (vectors.length < MIN) {
      console.warn(`⚠ ${slug}/${ageKey}: only ${vectors.length} samples (below min ${MIN}) — centroid will be noisy`);
    }
  }

  perCategory[slug] = { sampleCounts, centroids };
}

// ── Step 4: write ────────────────────────────────────────────────────────────

const payload = {
  version:     2,
  dim:         DIM,
  builtAt:     new Date().toISOString(),
  perCategory,
};

writeFileSync(OUTPUT, JSON.stringify(payload, null, 2) + "\n");
const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1);

const populatedBuckets = Object.entries(perCategory).reduce((n, [, c]) =>
  n + Object.values(c.centroids).filter(Boolean).length, 0);
const totalBuckets = CATEGORY_SLUGS.length * AGE_KEYS.length;

console.log(`\n✓ Wrote per-category centroids (${populatedBuckets}/${totalBuckets} buckets populated, ${DIM}-dim) to ${OUTPUT} (${kb} KB)`);
