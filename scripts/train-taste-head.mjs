/**
 * Train the taste-aware projection head on top of FashionCLIP.
 *
 * Data source: Supabase `curation_logs` table (primary) with JSONL fallback
 * at data/curation-log.jsonl for local dev.
 *
 * Model:  a single linear layer W ∈ R^(D×D) that maps raw FashionCLIP
 *         vectors into a Vitrine-taste-aware space of the same dimension.
 *         Initialized to identity so the model starts as a no-op and only
 *         moves where the data disagrees with FashionCLIP's default
 *         similarity metric.
 *
 * Loss:   within-curation triplet loss. For each logged run we form
 *           (anchor = kept[i], positive = kept[j], negative = rejected[k])
 *         triplets and push the anchor/positive pair closer together in
 *         projected space than the anchor/negative pair, by a margin.
 *
 * Eval:   80/20 split. After training we report BOTH train and test triplet
 *         accuracy, plus the test accuracy of the PREVIOUS W (if it exists)
 *         measured on the same held-out triplets. A new W is only "promoted"
 *         when its test accuracy beats the previous by at least PROMO_MARGIN.
 *
 * Output: lib/taste-head.json — { version, dim, trainedAt, samples, accuracy,
 *         testAccuracy, previousTestAccuracy, W }.
 *
 * Exit codes:
 *   0 — wrote new weights (or --dry-run finished cleanly)
 *   2 — promotion skipped because test accuracy didn't beat the previous W
 *   1 — error (missing env, no data, Pinecone fetch failure, etc.)
 *
 * Run:
 *   PINECONE_API_KEY=<key> node scripts/train-taste-head.mjs
 *     Options:
 *       --epochs 20              default 15
 *       --lr 0.01                default 0.01
 *       --margin 0.2             default 0.2
 *       --split 0.2              held-out fraction, default 0.2
 *       --promo-margin 0.01      min test-acc lift to promote, default 0.01
 *       --max-rows N             cap Supabase rows fetched (default: all)
 *       --max-samples N          cap triplets (default: all)
 *       --source supabase|jsonl  force one source, default: supabase with jsonl fallback
 *       --dry-run                report stats, don't write lib/taste-head.json
 */

import { Pinecone } from "@pinecone-database/pinecone";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

// ── Config / flags ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v == null || v.startsWith("--")) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}
const EPOCHS       = Number(flag("epochs", 15));
const LR           = Number(flag("lr", 0.01));
const MARGIN       = Number(flag("margin", 0.2));
const SPLIT        = Number(flag("split", 0.2));
const PROMO_MARGIN = Number(flag("promo-margin", 0.01));
const MAX_SAMPLES  = Number(flag("max-samples", Infinity));
const MAX_ROWS     = Number(flag("max-rows", Infinity));
const SOURCE       = String(flag("source", "auto"));
const DRY_RUN      = args.includes("--dry-run");

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX   = process.env.PINECONE_INDEX ?? "muse";
const SUPABASE_URL     = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LOG_FILE         = path.resolve("data/curation-log.jsonl");
const OUTPUT_FILE      = path.resolve("lib/taste-head.json");

if (!PINECONE_API_KEY) { console.error("Missing PINECONE_API_KEY"); process.exit(1); }

// ── Math primitives ───────────────────────────────────────────────────────────

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// y = W · x  (W is D×D, stored row-major as Float64Array of length D*D)
function matVec(W, x, D) {
  const out = new Float64Array(D);
  for (let i = 0; i < D; i++) {
    let s = 0;
    const base = i * D;
    for (let j = 0; j < D; j++) s += W[base + j] * x[j];
    out[i] = s;
  }
  return out;
}

function identityMatrix(D) {
  const W = new Float64Array(D * D);
  for (let i = 0; i < D; i++) W[i * D + i] = 1;
  return W;
}

// ── Load curation log (Supabase first, JSONL fallback) ───────────────────────

async function loadFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  // Supabase paginates — page through until we've read everything (or hit MAX_ROWS).
  const PAGE = 1000;
  const out  = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const limit = Math.min(PAGE, MAX_ROWS - offset);
    const { data, error } = await sb
      .from("curation_logs")
      .select("dna_hash, kept_ids, rejected_ids, candidate_ids, board_image_urls, created_at")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) { console.warn("  supabase fetch error:", error.message); return null; }
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < limit) break;
  }
  return out;
}

function loadFromJsonl() {
  if (!existsSync(LOG_FILE)) return null;
  return readFileSync(LOG_FILE, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);
}

console.log("Loading curation log…");
let rows = null;
let sourceLabel = "";
if (SOURCE === "jsonl") {
  rows = loadFromJsonl();
  sourceLabel = `jsonl (${LOG_FILE})`;
} else if (SOURCE === "supabase") {
  rows = await loadFromSupabase();
  sourceLabel = "supabase";
} else {
  rows = await loadFromSupabase();
  if (rows && rows.length > 0) {
    sourceLabel = "supabase";
  } else {
    rows = loadFromJsonl();
    sourceLabel = `jsonl fallback (${LOG_FILE})`;
  }
}

if (!rows || rows.length === 0) {
  console.error(`No rows from ${sourceLabel || "any source"}.`);
  console.error("Run a few curate calls (or import historical JSONL via scripts/import-curation-log-to-supabase.mjs) and try again.");
  process.exit(1);
}
console.log(`  ${rows.length} curation runs from ${sourceLabel}`);

// Collect the unique product IDs we need vectors for.
const allIds = new Set();
for (const r of rows) {
  for (const id of r.kept_ids     ?? []) allIds.add(id);
  for (const id of r.rejected_ids ?? []) allIds.add(id);
}
console.log(`  ${allIds.size} unique product IDs referenced`);

// ── Fetch Pinecone vectors ────────────────────────────────────────────────────

console.log(`\nFetching vectors from Pinecone index "${PINECONE_INDEX}"…`);
const pc    = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = pc.index(PINECONE_INDEX);
const vecById = new Map();
const ids     = Array.from(allIds);
const CHUNK   = 100;
let fetched   = 0;
for (let i = 0; i < ids.length; i += CHUNK) {
  const chunk = ids.slice(i, i + CHUNK);
  const res = await index.fetch({ ids: chunk }).catch((e) => { console.warn("  fetch error:", e.message); return null; });
  if (res?.records) {
    for (const [id, rec] of Object.entries(res.records)) {
      if (rec?.values?.length) vecById.set(id, Array.from(rec.values));
    }
  }
  fetched += chunk.length;
  process.stdout.write(`\r  ${fetched}/${ids.length} queried, ${vecById.size} hit`);
}
console.log();

if (vecById.size === 0) {
  console.error("No vectors returned from Pinecone — cannot train.");
  process.exit(1);
}

const DIM = vecById.values().next().value.length;
console.log(`  vector dim = ${DIM}`);

// ── Build triplets ────────────────────────────────────────────────────────────

console.log("\nBuilding triplets (anchor ∈ kept, positive ∈ kept, negative ∈ rejected) per curation run…");
const triplets = []; // array of { a, p, n } — each is a vector
for (const r of rows) {
  const keptVecs    = (r.kept_ids     ?? []).map((id) => vecById.get(id)).filter(Boolean);
  const rejectVecs  = (r.rejected_ids ?? []).map((id) => vecById.get(id)).filter(Boolean);
  if (keptVecs.length < 2 || rejectVecs.length < 1) continue;
  // Sample at most min(keptC2, rejects) triplets per run so a single large
  // curation doesn't dominate the loss.
  const maxPerRun = Math.min(keptVecs.length * 2, rejectVecs.length * 4, 40);
  for (let i = 0; i < maxPerRun; i++) {
    const ai = Math.floor(Math.random() * keptVecs.length);
    let pi = Math.floor(Math.random() * keptVecs.length);
    if (pi === ai) pi = (pi + 1) % keptVecs.length;
    const ni = Math.floor(Math.random() * rejectVecs.length);
    triplets.push({ a: keptVecs[ai], p: keptVecs[pi], n: rejectVecs[ni] });
  }
}
console.log(`  built ${triplets.length} triplets from ${rows.length} runs`);
if (triplets.length === 0) {
  console.error("No triplets could be formed (most runs need ≥2 kept and ≥1 rejected with vectors present).");
  process.exit(1);
}
const capped = MAX_SAMPLES < triplets.length
  ? triplets.slice(0, MAX_SAMPLES)
  : triplets;

// 80/20 held-out split. Shuffle then slice so train and test are disjoint.
// We pre-normalize inputs here (once per triplet) so both the training loop
// and the eval loops work in unit-sphere space throughout.
for (let i = capped.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [capped[i], capped[j]] = [capped[j], capped[i]];
}
for (const t of capped) {
  t.a = normalize(t.a);
  t.p = normalize(t.p);
  t.n = normalize(t.n);
}
const splitIdx         = Math.max(1, Math.floor(capped.length * (1 - SPLIT)));
const trainingTriplets = capped.slice(0, splitIdx);
const testTriplets     = capped.slice(splitIdx);
console.log(`  split: ${trainingTriplets.length} train / ${testTriplets.length} test (held-out ${(SPLIT * 100).toFixed(0)}%)`);

// ── Train ─────────────────────────────────────────────────────────────────────
// Triplet loss L = max(0, margin - <Wa, Wp> + <Wa, Wn>) with L2-normalized
// vectors on input. We differentiate through to W with analytic gradients and
// do vanilla SGD; that's enough for a D=512 linear head on small datasets.

console.log(`\nTraining: epochs=${EPOCHS}  lr=${LR}  margin=${MARGIN}  D=${DIM}  triplets=${trainingTriplets.length}`);

let W = identityMatrix(DIM);

for (let epoch = 0; epoch < EPOCHS; epoch++) {
  // Shuffle
  for (let i = trainingTriplets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [trainingTriplets[i], trainingTriplets[j]] = [trainingTriplets[j], trainingTriplets[i]];
  }

  let totalLoss = 0;
  let active    = 0;
  for (const { a, p, n } of trainingTriplets) {
    const Wa = matVec(W, a, DIM);
    const Wp = matVec(W, p, DIM);
    const Wn = matVec(W, n, DIM);
    const sap = dot(Wa, Wp);
    const san = dot(Wa, Wn);
    const loss = MARGIN - sap + san;
    if (loss <= 0) continue; // inactive margin
    active++;
    totalLoss += loss;

    // dL/dW via outer products:
    //   sap = (Wa)·(Wp) = a^T W^T W p  →  dSap/dW = W(a p^T + p a^T)
    //   san = (Wa)·(Wn)                →  dSan/dW = W(a n^T + n a^T)
    //   dL/dW = -dSap + dSan
    // We apply directly as an SGD step so we never materialize the full
    // D×D gradient — each rank-1 update is O(D^2) and batches to O(D^2).
    // Net update: W -= lr * W * (-(a p^T + p a^T) + (a n^T + n a^T))
    //           = W += lr * W * (a (p - n)^T + (p - n) a^T)
    // Split into two rank-1 terms: outer(a, p - n) and outer(p - n, a).
    const pn = new Array(DIM);
    for (let i = 0; i < DIM; i++) pn[i] = p[i] - n[i];

    const tmp1 = matVec(W, a, DIM);
    const tmp2 = matVec(W, pn, DIM);

    for (let i = 0; i < DIM; i++) {
      const u1 = LR * tmp1[i];
      const u2 = LR * tmp2[i];
      const base = i * DIM;
      for (let j = 0; j < DIM; j++) {
        W[base + j] += u1 * pn[j] + u2 * a[j];
      }
    }
  }

  const avg = active > 0 ? totalLoss / active : 0;
  console.log(`  epoch ${String(epoch + 1).padStart(2)}/${EPOCHS}  active=${active}/${trainingTriplets.length}  avg_loss=${avg.toFixed(4)}`);
}

// ── Evaluate ──────────────────────────────────────────────────────────────────
// Three numbers:
//   1. trainAcc: how well the freshly-trained W sorts its training triplets
//   2. testAcc:  how well the trained W sorts the held-out set (the real signal)
//   3. prevTestAcc: how well the PREVIOUSLY shipped W sorts the same held-out
//      set — so we can decide whether this new W is actually an improvement.

function tripletAccuracy(weights, set) {
  if (!set.length) return 0;
  let correct = 0;
  for (const { a, p, n } of set) {
    const Wa = matVec(weights, a, DIM);
    const Wp = matVec(weights, p, DIM);
    const Wn = matVec(weights, n, DIM);
    if (dot(Wa, Wp) > dot(Wa, Wn)) correct++;
  }
  return correct / set.length;
}

const trainAcc = tripletAccuracy(W, trainingTriplets);
const testAcc  = tripletAccuracy(W, testTriplets);

// Load the previous W (if any) so we can score it on the same held-out
// triplets as the new W. Missing file → prevTestAcc = 0 which lets any
// non-degenerate new W promote on first run.
let prevTestAcc = 0;
let prevHasW    = false;
if (existsSync(OUTPUT_FILE)) {
  try {
    const prev = JSON.parse(readFileSync(OUTPUT_FILE, "utf8"));
    if (Array.isArray(prev?.W) && prev.dim === DIM) {
      const prevW = new Float64Array(prev.W);
      prevTestAcc = tripletAccuracy(prevW, testTriplets);
      prevHasW    = true;
    }
  } catch { /* treat as no previous */ }
}

console.log(`\nTriplet accuracy:`);
console.log(`  train          : ${(trainAcc   * 100).toFixed(1)}% (${trainingTriplets.length} pairs)`);
console.log(`  test (new W)   : ${(testAcc    * 100).toFixed(1)}% (${testTriplets.length} pairs)`);
if (prevHasW) {
  console.log(`  test (prev W)  : ${(prevTestAcc * 100).toFixed(1)}%`);
  console.log(`  lift vs prev   : ${((testAcc - prevTestAcc) * 100).toFixed(2)} pp`);
} else {
  console.log(`  test (prev W)  : — (no previous weights on disk)`);
}

// ── Promotion gating ──────────────────────────────────────────────────────────
// A new W is "promoted" (written to disk) only when its held-out accuracy
// beats the previous W by PROMO_MARGIN. This makes the cron safe: a bad
// training run can't silently ship because CI sees a non-zero exit code
// and skips the follow-up apply/commit steps.

const promote = testAcc >= prevTestAcc + PROMO_MARGIN;

if (DRY_RUN) {
  console.log(`\n--dry-run: would ${promote ? "PROMOTE" : "SKIP"} (testAcc ${(testAcc*100).toFixed(1)}% vs prev ${(prevTestAcc*100).toFixed(1)}% + margin ${(PROMO_MARGIN*100).toFixed(1)}%)`);
  process.exit(promote ? 0 : 2);
}

if (!promote) {
  console.log(`\n⏸  Skipping promotion: testAcc ${(testAcc*100).toFixed(1)}% did not exceed prev ${(prevTestAcc*100).toFixed(1)}% by ${(PROMO_MARGIN*100).toFixed(1)}pp.`);
  console.log(`   Keeping ${OUTPUT_FILE} unchanged.`);
  process.exit(2);
}

// ── Write the weights ─────────────────────────────────────────────────────────

const payload = {
  version:              2,
  dim:                  DIM,
  epochs:               EPOCHS,
  lr:                   LR,
  margin:               MARGIN,
  trainedAt:            new Date().toISOString(),
  samples:              trainingTriplets.length + testTriplets.length,
  trainSamples:         trainingTriplets.length,
  testSamples:          testTriplets.length,
  accuracy:             trainAcc,            // back-compat
  trainAccuracy:        trainAcc,
  testAccuracy:         testAcc,
  previousTestAccuracy: prevHasW ? prevTestAcc : null,
  curationRows:         rows.length,
  // Truncate to 6 sig figs to keep the JSON small — 512×512 × 8 bytes = 2 MB raw.
  W: Array.from(W, (x) => +x.toFixed(6)),
};
writeFileSync(OUTPUT_FILE, JSON.stringify(payload));
console.log(`\n✓ Promoted: wrote ${OUTPUT_FILE}  (${(payload.W.length * 7 / 1024 / 1024).toFixed(1)} MB on disk)`);
