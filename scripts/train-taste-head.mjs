/**
 * Train the taste-aware projection head on top of FashionCLIP.
 *
 * Input:  data/curation-log.jsonl — one row per curateProducts decision,
 *         see lib/curation-log.ts for the schema.
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
 *         "Kept products from the same board are more alike than rejected
 *         products from the same board" is Claude's judgment expressed as
 *         a training signal.
 *
 * Output: lib/taste-head.json — { version, dim, trainedAt, samples, W }.
 *         lib/taste-head.ts is the matching inference module.
 *
 * Run:
 *   PINECONE_API_KEY=<key> node scripts/train-taste-head.mjs
 *     Options:
 *       --epochs 20        default 15
 *       --lr 0.01          default 0.01
 *       --margin 0.2       default 0.2
 *       --max-samples N    subsample triplets for a quick dry-run
 *       --dry-run          just report stats, don't write lib/taste-head.json
 */

import { Pinecone } from "@pinecone-database/pinecone";
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
const EPOCHS      = Number(flag("epochs", 15));
const LR          = Number(flag("lr", 0.01));
const MARGIN      = Number(flag("margin", 0.2));
const MAX_SAMPLES = Number(flag("max-samples", Infinity));
const DRY_RUN     = args.includes("--dry-run");

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX   = process.env.PINECONE_INDEX ?? "muse";
const LOG_FILE         = path.resolve("data/curation-log.jsonl");
const OUTPUT_FILE      = path.resolve("lib/taste-head.json");

if (!PINECONE_API_KEY) { console.error("Missing PINECONE_API_KEY"); process.exit(1); }
if (!existsSync(LOG_FILE)) {
  console.error(`No curation log at ${LOG_FILE}`);
  console.error("Run the app and let a few curate calls complete first — the logger appends to this file.");
  process.exit(1);
}

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

// ── Load curation log ─────────────────────────────────────────────────────────

console.log(`Loading curation log from ${LOG_FILE}…`);
const rows = readFileSync(LOG_FILE, "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => { try { return JSON.parse(s); } catch { return null; } })
  .filter(Boolean);

console.log(`  ${rows.length} curation runs logged`);
if (rows.length === 0) { console.error("No usable rows; exiting."); process.exit(1); }

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
const trainingTriplets = MAX_SAMPLES < triplets.length
  ? triplets.slice(0, MAX_SAMPLES)
  : triplets;

// ── Train ─────────────────────────────────────────────────────────────────────
// Triplet loss L = max(0, margin - <Wa, Wp> + <Wa, Wn>) with L2-normalized
// vectors on input. We differentiate through to W with analytic gradients and
// do vanilla SGD; that's enough for a D=512 linear head on small datasets.

console.log(`\nTraining: epochs=${EPOCHS}  lr=${LR}  margin=${MARGIN}  D=${DIM}  triplets=${trainingTriplets.length}`);

// Pre-normalize inputs; we work in unit-sphere space throughout.
for (const t of trainingTriplets) {
  t.a = normalize(t.a);
  t.p = normalize(t.p);
  t.n = normalize(t.n);
}

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

    // tmp1 = W · a  (DIM)
    // tmp2 = W · (p - n)  (DIM)
    const tmp1 = matVec(W, a, DIM);
    const tmp2 = matVec(W, pn, DIM);

    //  W += lr * ( tmp1 * pn^T + tmp2 * a^T )
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

// ── Evaluate spread ───────────────────────────────────────────────────────────
// Post-training: how often does the projected similarity prefer kept-over-rejected?

let correct = 0;
for (const { a, p, n } of trainingTriplets) {
  const Wa = matVec(W, a, DIM);
  const Wp = matVec(W, p, DIM);
  const Wn = matVec(W, n, DIM);
  if (dot(Wa, Wp) > dot(Wa, Wn)) correct++;
}
const acc = trainingTriplets.length === 0 ? 0 : correct / trainingTriplets.length;
console.log(`\nTriplet accuracy (projected space): ${(acc * 100).toFixed(1)}% (${correct}/${trainingTriplets.length})`);

// ── Write the weights ─────────────────────────────────────────────────────────

if (DRY_RUN) {
  console.log("\n--dry-run: skipping write.");
  process.exit(0);
}

const payload = {
  version:    1,
  dim:        DIM,
  epochs:     EPOCHS,
  lr:         LR,
  margin:     MARGIN,
  trainedAt:  new Date().toISOString(),
  samples:    trainingTriplets.length,
  accuracy:   acc,
  // Truncate to 6 sig figs to keep the JSON small — 512×512 × 8 bytes = 2 MB raw.
  W: Array.from(W, (x) => +x.toFixed(6)),
};
writeFileSync(OUTPUT_FILE, JSON.stringify(payload));
console.log(`\n✓ Wrote ${OUTPUT_FILE}  (${(payload.W.length * 7 / 1024 / 1024).toFixed(1)} MB on disk)`);
