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

// ── Group ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, string[]>} aesthetic → objectIDs */
const byAesthetic = new Map();
for (const [objectID, aesthetic] of labelEntries) {
  if (typeof objectID !== "string" || typeof aesthetic !== "string") continue;
  if (!byAesthetic.has(aesthetic)) byAesthetic.set(aesthetic, []);
  byAesthetic.get(aesthetic).push(objectID);
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log(`Loaded ${labelEntries.length} labels across ${byAesthetic.size} aesthetics.\n`);
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
  // Cross-aesthetic negatives: every other labeled item gets used as a negative.
  // train-taste-head.mjs will sample down to maxPerRun per row, so it's fine to
  // pass the full pool; the sampler caps it.
  const rejectedIds = [];
  for (const id of allLabeledIds) {
    if (labels[id] !== aesthetic) rejectedIds.push(id);
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
