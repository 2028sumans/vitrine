/**
 * Convert hand-labeled per-category golden datasets into curation-log-format
 * rows that scripts/build-age-centroids.mjs (and any future taste-head
 * trainer) can consume.
 *
 * Per-category model
 * ------------------
 * Each /admin/label/<category> page produces its own download named
 * `eval-labels-<category>-<ts>.json`. After labeling you move the latest
 * download for each category to `data/eval-labels-<category>.json` (no
 * timestamp), and run this script.
 *
 * One eval-set output is produced per category with files in `data/`:
 *   data/eval-labels-tops.json     →  data/eval-set-tops.jsonl
 *   data/eval-labels-shoes.json    →  data/eval-set-shoes.jsonl
 *   ...etc
 *
 * Categories without a labels file are skipped silently (you might be
 * mid-curation on shoes but not bags-and-accessories yet).
 *
 * Output shape per row:
 *   { dna_hash: "eval:tops:age-25-32",
 *     kept_ids: [...items tagged this age within this category],
 *     rejected_ids: [...other items in this same category labeled elsewhere],
 *     candidate_ids, board_image_urls, created_at, source: "eval", category: "tops" }
 *
 * Why per-category negatives only (not cross-category): training a taste
 * head on cross-category triplets would just teach the model that a shoe
 * is not a top, which we already know from the catalog's category field.
 * Useful contrast lives WITHIN a category — across age groups.
 *
 * Usage
 * -----
 *   node scripts/build-eval-triplets.mjs                       # all categories
 *   node scripts/build-eval-triplets.mjs --category shoes     # one category
 *   node scripts/build-eval-triplets.mjs --min 20             # warn-below threshold
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getFlag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return (v == null || v.startsWith("--")) ? fallback : v;
}

const ONLY_CATEGORY      = getFlag("category", null);
const MIN_PER_AESTHETIC  = Number(getFlag("min", "20"));
const DATA_DIR           = path.resolve(__dirname, "..", "data");

// ── Category taxonomy ────────────────────────────────────────────────────────
// Mirrors lib/category-taxonomy.ts. We don't import the .ts file because this
// script runs under plain Node — keeping the slugs duplicated here is cheaper
// than wiring a TS loader, and the list rarely changes.

const CATEGORY_SLUGS = [
  "tops", "dresses", "bottoms", "knits", "outerwear",
  "shoes", "bags-and-accessories",
];

const slugsToProcess = ONLY_CATEGORY
  ? (CATEGORY_SLUGS.includes(ONLY_CATEGORY) ? [ONLY_CATEGORY] : [])
  : CATEGORY_SLUGS;

if (ONLY_CATEGORY && slugsToProcess.length === 0) {
  console.error(`✗ Unknown category: ${ONLY_CATEGORY}`);
  console.error(`  Known slugs: ${CATEGORY_SLUGS.join(", ")}`);
  process.exit(1);
}

// ── Per-category processing ───────────────────────────────────────────────────

let processed = 0;
let skipped   = 0;

for (const slug of slugsToProcess) {
  const inputPath  = path.join(DATA_DIR, `eval-labels-${slug}.json`);
  const outputPath = path.join(DATA_DIR, `eval-set-${slug}.jsonl`);

  if (!fs.existsSync(inputPath)) {
    if (ONLY_CATEGORY) {
      console.error(`✗ ${slug}: input not found at ${path.relative(process.cwd(), inputPath)}`);
      console.error(`  Tip: download from /admin/label/${slug}, then mv ~/Downloads/eval-labels-${slug}-*.json ${path.relative(process.cwd(), inputPath)}`);
      process.exit(1);
    }
    skipped++;
    continue;
  }

  let store;
  try {
    store = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch (e) {
    console.error(`✗ ${slug}: couldn't parse ${inputPath}: ${e.message}`);
    continue;
  }

  const labels = store?.labels ?? {};
  const labelEntries = Object.entries(labels);
  if (labelEntries.length === 0) {
    console.warn(`⚠ ${slug}: no labels in file — skipped`);
    continue;
  }

  // Normalise to arrays (defensive against any stale single-string entries).
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

  // Group: aesthetic → objectIDs tagged with it (within this category)
  const byAesthetic = new Map();
  for (const [objectID, tags] of tagsById) {
    for (const aesthetic of tags) {
      if (!byAesthetic.has(aesthetic)) byAesthetic.set(aesthetic, []);
      byAesthetic.get(aesthetic).push(objectID);
    }
  }

  // Report
  const totalTags  = [...tagsById.values()].reduce((n, arr) => n + arr.length, 0);
  console.log(`\n[${slug}] ${totalTags} tags across ${tagsById.size} unique items in ${byAesthetic.size} aesthetics:`);
  let anyUnder = false;
  for (const [aesthetic, ids] of [...byAesthetic.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const warn = ids.length < MIN_PER_AESTHETIC ? " ← below min" : "";
    if (ids.length < MIN_PER_AESTHETIC) anyUnder = true;
    console.log(`  ${aesthetic.padEnd(14)} ${String(ids.length).padStart(4)}${warn}`);
  }
  if (anyUnder) {
    console.log(`  ⚠ One or more aesthetics have fewer than ${MIN_PER_AESTHETIC} items in this category.`);
  }

  // Write per-aesthetic rows. Negatives = items WITHIN this category that
  // don't carry the current aesthetic tag — purely intra-category contrast.
  const allLabeledIds = new Set(tagsById.keys());
  const now = new Date().toISOString();
  const lines = [];
  for (const [aesthetic, keptIds] of byAesthetic) {
    const rejectedIds = [];
    for (const id of allLabeledIds) {
      const tags = tagsById.get(id) ?? [];
      if (!tags.includes(aesthetic)) rejectedIds.push(id);
    }
    lines.push(JSON.stringify({
      dna_hash:         `eval:${slug}:${aesthetic}`,
      dna_summary:      `Hand-labeled ${slug} eval set — aesthetic: ${aesthetic}`,
      kept_ids:         keptIds,
      rejected_ids:     rejectedIds,
      candidate_ids:    [...keptIds, ...rejectedIds],
      board_image_urls: [],
      created_at:       now,
      source:           "eval",
      category:         slug,
    }));
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join("\n") + "\n");
  const kb = (fs.statSync(outputPath).size / 1024).toFixed(1);
  console.log(`  ✓ Wrote ${lines.length} rows to ${path.relative(process.cwd(), outputPath)} (${kb} KB)`);
  processed++;
}

console.log(`\nProcessed ${processed} categories. ${skipped > 0 ? `${skipped} skipped (no labels file).` : ""}`);
if (processed > 0) {
  console.log(`\nNext: node scripts/build-age-centroids.mjs   # builds lib/age-centroids.json`);
}
