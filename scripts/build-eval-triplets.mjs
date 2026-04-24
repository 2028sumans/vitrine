/**
 * Convert hand-labeled aesthetic sets into curation-log-format rows that
 * `scripts/train-taste-head.mjs` (and the upcoming preference-head / LoRA
 * scripts) can consume without code change.
 *
 * Input
 * -----
 *   data/eval-labels.json  (exported from /admin/label in the app)
 *   Shape:
 *     {
 *       version: 1,
 *       labels:   { [objectID]: "<aesthetic-key>" },
 *       products: { [objectID]: { title, brand, image_url, category? } },
 *       updatedAt: "2026-04-24T..."
 *     }
 *
 * Output
 * ------
 *   data/eval-set.jsonl
 *   One row per aesthetic, matching the curation_logs schema:
 *     {
 *       dna_hash:         "eval:<aesthetic-key>",
 *       kept_ids:         [ ...objectIDs labeled with this aesthetic ],
 *       rejected_ids:     [ ...objectIDs labeled with any OTHER aesthetic ],
 *       candidate_ids:    [ ...kept + rejected ],
 *       board_image_urls: [],
 *       created_at:       <now>
 *     }
 *
 *   Why this shape: train-taste-head.mjs builds triplets as
 *     (anchor ∈ kept, positive ∈ kept, negative ∈ rejected)
 *   per row. Mapping each aesthetic to its own row + cross-aesthetic negatives
 *   gives the model exactly the contrast we want: "things labeled minimalist
 *   French should cluster; things labeled anything-else should push away."
 *
 * Usage
 * -----
 *   node scripts/build-eval-triplets.mjs
 *   node scripts/build-eval-triplets.mjs --input path/to/labels.json
 *   node scripts/build-eval-triplets.mjs --out data/custom.jsonl
 *   node scripts/build-eval-triplets.mjs --min 10        # warn if any aesthetic < 10
 *
 * After running, feed it to the trainer:
 *   # Eval set alone (pure hand-labeled signal)
 *   cp data/eval-set.jsonl data/curation-log.jsonl  # WARNING: overwrites real logs
 *   node scripts/train-taste-head.mjs --source jsonl
 *
 *   # Or merged with real curation logs (recommended once both exist — we'll
 *   # wire a first-class --eval-set flag into train-taste-head.mjs in the next
 *   # step so you don't have to cat/concat by hand).
 */

import fs from "fs";
import path from "path";

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getFlag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return (v == null || v.startsWith("--")) ? fallback : v;
}

const INPUT  = getFlag("input", "data/eval-labels.json");
const OUTPUT = getFlag("out",   "data/eval-set.jsonl");
const MIN_PER_AESTHETIC = Number(getFlag("min", "20"));

// ── Load + validate ───────────────────────────────────────────────────────────

if (!fs.existsSync(INPUT)) {
  console.error(`✗ Input not found: ${INPUT}`);
  console.error(`  Tip: export from /admin/label in the app, then move the downloaded file to ${INPUT}`);
  process.exit(1);
}

let store;
try {
  store = JSON.parse(fs.readFileSync(INPUT, "utf8"));
} catch (e) {
  console.error(`✗ Couldn't parse ${INPUT}: ${e.message}`);
  process.exit(1);
}

const labels   = store?.labels   ?? {};
const products = store?.products ?? {};
const labelEntries = Object.entries(labels);

if (labelEntries.length === 0) {
  console.error(`✗ No labels in ${INPUT}`);
  process.exit(1);
}

// ── Normalise + group ─────────────────────────────────────────────────────────
//
// The admin tool writes multi-label files (objectID → string[]) from v2
// onwards, but we also keep compat with v1 single-label downloads (objectID
// → string). Coerce everything to arrays before grouping.

/** @type {Map<string, string[]>} objectID → aesthetic keys the item carries */
const tagsById = new Map();
for (const [objectID, raw] of labelEntries) {
  if (typeof objectID !== "string") continue;
  const tags = Array.isArray(raw)
    ? raw.filter((k) => typeof k === "string")
    : typeof raw === "string" && raw.length > 0
      ? [raw]
      : [];
  if (tags.length > 0) tagsById.set(objectID, tags);
}

/** @type {Map<string, string[]>} aesthetic → objectIDs tagged with it */
const byAesthetic = new Map();
for (const [objectID, tags] of tagsById) {
  for (const aesthetic of tags) {
    if (!byAesthetic.has(aesthetic)) byAesthetic.set(aesthetic, []);
    byAesthetic.get(aesthetic).push(objectID);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

const totalTags  = [...tagsById.values()].reduce((n, arr) => n + arr.length, 0);
const uniqueItems = tagsById.size;
console.log(`Loaded ${totalTags} tags across ${uniqueItems} unique items in ${byAesthetic.size} aesthetics.\n`);
let anyUnder = false;
const sortedAesthetics = [...byAesthetic.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [aesthetic, ids] of sortedAesthetics) {
  const short = aesthetic.length > 28 ? aesthetic.slice(0, 25) + "…" : aesthetic;
  const warn  = ids.length < MIN_PER_AESTHETIC ? " ← below min" : "";
  if (ids.length < MIN_PER_AESTHETIC) anyUnder = true;
  console.log(`  ${short.padEnd(30)} ${String(ids.length).padStart(4)}${warn}`);
}
if (anyUnder) {
  console.log(`\n⚠ One or more aesthetics have fewer than ${MIN_PER_AESTHETIC} items.`);
  console.log(`  Triplet loss degrades sharply below ~20/aesthetic — consider labeling more.`);
}

// ── Write curation-log-format rows ────────────────────────────────────────────

const allLabeledIds = new Set(Object.keys(labels));
const now = new Date().toISOString();

const lines = [];
for (const [aesthetic, keptIds] of byAesthetic) {
  // Cross-aesthetic negatives: every labeled item NOT tagged with this
  // aesthetic gets used as a negative. An item tagged with both 25-32
  // and 32-40 is in the kept set for both buckets and the rejected set
  // for 13-18 / 18-25 / 40-60 — correct contrastive structure.
  // train-taste-head.mjs samples down to maxPerRun per row, so passing
  // the full pool is fine; the sampler caps it.
  const rejectedIds = [];
  for (const id of allLabeledIds) {
    const tags = tagsById.get(id) ?? [];
    if (!tags.includes(aesthetic)) rejectedIds.push(id);
  }

  lines.push(JSON.stringify({
    dna_hash:         `eval:${aesthetic}`,
    dna_summary:      `Hand-labeled eval set — aesthetic: ${aesthetic}`,
    kept_ids:         keptIds,
    rejected_ids:     rejectedIds,
    candidate_ids:    [...keptIds, ...rejectedIds],
    board_image_urls: [],
    created_at:       now,
    source:           "eval",  // marker so we can tell eval rows apart later
  }));
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, lines.join("\n") + "\n");

const kb = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
console.log(`\n✓ Wrote ${lines.length} aesthetic rows to ${OUTPUT} (${kb} KB)`);
console.log(`\nNext step:`);
console.log(`  node scripts/train-taste-head.mjs   # (once --eval-set flag lands)`);
