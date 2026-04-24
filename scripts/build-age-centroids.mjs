/**
 * Compute per-age-range FashionCLIP centroids from the hand-labeled eval set.
 *
 * Pipeline
 * --------
 *   1. Read data/eval-set.jsonl (written by scripts/build-eval-triplets.mjs,
 *      which in turn reads the download from /admin/label).
 *   2. For each age bucket row (dna_hash = "eval:age-NN-NN"), collect
 *      kept_ids — these are the items the user tagged as belonging to
 *      that age range.
 *   3. Fetch each item's 512-dim vector from Pinecone (default namespace,
 *      the visual FashionCLIP space).
 *   4. Average per bucket, L2-normalize, write to lib/age-centroids.json.
 *
 * When the downstream `lib/taste-profile.ts` loads a user's taste vector,
 * it pulls their age bucket's centroid from the file this script produces
 * and blends it with their quiz-uploaded image vectors.
 *
 * Usage
 * -----
 *   # Defaults: read data/eval-set.jsonl, write lib/age-centroids.json.
 *   PINECONE_API_KEY=<key> node scripts/build-age-centroids.mjs
 *
 *   # Flags
 *     --input  path   override input path (default: data/eval-set.jsonl)
 *     --out    path   override output path (default: lib/age-centroids.json)
 *     --min    N      warn if any bucket has fewer than N items (default: 20)
 *
 * Safe to re-run — the output file is rewritten on each invocation.
 */

import { Pinecone } from "@pinecone-database/pinecone";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

// ── Flags ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return (v == null || v.startsWith("--")) ? fallback : v;
}
const INPUT  = flag("input", "data/eval-set.jsonl");
const OUTPUT = flag("out",   "lib/age-centroids.json");
const MIN    = Number(flag("min", "20"));

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX   = process.env.PINECONE_INDEX ?? "muse";

if (!PINECONE_API_KEY) {
  console.error("Missing PINECONE_API_KEY — set it in the environment or .env.local.");
  process.exit(1);
}

// ── Load eval rows ────────────────────────────────────────────────────────────

if (!existsSync(INPUT)) {
  console.error(`✗ Input not found: ${INPUT}`);
  console.error("  Run scripts/build-eval-triplets.mjs first to produce it.");
  process.exit(1);
}

const rows = readFileSync(INPUT, "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => { try { return JSON.parse(s); } catch { return null; } })
  .filter(Boolean);

// Keep only rows whose dna_hash starts with "eval:age-" — that's our age labels.
// Ignore anything else (real curation logs, other eval rows).
const ageRows = rows.filter((r) => typeof r.dna_hash === "string" && r.dna_hash.startsWith("eval:age-"));
if (ageRows.length === 0) {
  console.error(`✗ No age-labeled rows in ${INPUT} (expected dna_hash like "eval:age-25-32").`);
  console.error("  Make sure you labeled items at /admin/label and ran build-eval-triplets.mjs.");
  process.exit(1);
}

// Group: bucket key ("age-13-18") → [objectID, ...]
const idsByBucket = new Map();
for (const r of ageRows) {
  const bucket = r.dna_hash.replace(/^eval:/, "");
  if (!idsByBucket.has(bucket)) idsByBucket.set(bucket, []);
  idsByBucket.get(bucket).push(...(r.kept_ids ?? []));
}

const allIds = new Set();
for (const ids of idsByBucket.values()) for (const id of ids) allIds.add(id);

console.log(`Loaded ${ageRows.length} age-labeled rows referencing ${allIds.size} unique products.`);
for (const [bucket, ids] of idsByBucket) {
  const warn = ids.length < MIN ? "  ← below min" : "";
  console.log(`  ${bucket.padEnd(12)} ${String(ids.length).padStart(4)}${warn}`);
}

// ── Fetch vectors from Pinecone ───────────────────────────────────────────────

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
    console.warn(`  fetch error (chunk ${i}):`, e.message);
  }
  process.stdout.write(`\r  ${Math.min(i + CHUNK, idList.length)}/${idList.length} queried, ${vecById.size} hit`);
}
console.log();

if (vecById.size === 0) {
  console.error("✗ No vectors returned from Pinecone — cannot build centroids.");
  console.error("  Check PINECONE_API_KEY, PINECONE_INDEX, and that the labeled items are embedded.");
  process.exit(1);
}

const DIM = vecById.values().next().value.length;
console.log(`  vector dim = ${DIM}`);

// ── Compute centroids ─────────────────────────────────────────────────────────

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  return v.map((x) => x / n);
}

const centroids    = {};
const sampleCounts = {};
for (const [bucket, ids] of idsByBucket) {
  const vectors = ids.map((id) => vecById.get(id)).filter(Boolean);
  sampleCounts[bucket] = vectors.length;
  if (vectors.length === 0) {
    centroids[bucket] = null;
    continue;
  }
  // Component-wise average of normalized vectors. Normalize inputs so a single
  // item with an outlier magnitude can't dominate the bucket.
  const sum = new Array(DIM).fill(0);
  for (const v of vectors) {
    const nv = normalize(v);
    for (let i = 0; i < DIM; i++) sum[i] += nv[i];
  }
  const avg = sum.map((s) => s / vectors.length);
  centroids[bucket] = normalize(avg); // re-normalize so the centroid is unit length
}

// ── Write ─────────────────────────────────────────────────────────────────────

// Preserve the bucket order from the original source for deterministic output.
const orderedBuckets = ["age-13-18", "age-18-25", "age-25-32", "age-32-40", "age-40-60"];
const outCounts   = {};
const outCentroids = {};
for (const b of orderedBuckets) {
  outCounts[b]    = sampleCounts[b] ?? 0;
  outCentroids[b] = centroids[b]    ?? null;
}

const payload = {
  version:      1,
  dim:          DIM,
  builtAt:      new Date().toISOString(),
  sampleCounts: outCounts,
  centroids:    outCentroids,
};

writeFileSync(OUTPUT, JSON.stringify(payload, null, 2) + "\n");

const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1);
console.log(`\n✓ Wrote ${Object.keys(centroids).length} age centroids (${DIM}-dim) to ${OUTPUT} (${kb} KB)`);

// Warn on any bucket with 0 vectors — that bucket will be a no-op at read time.
const empty = orderedBuckets.filter((b) => outCentroids[b] == null);
if (empty.length > 0) {
  console.warn(`\n⚠ Empty buckets (no vectors found): ${empty.join(", ")}`);
  console.warn("  Those ages will fall back to upload-only centroids at read time.");
}
