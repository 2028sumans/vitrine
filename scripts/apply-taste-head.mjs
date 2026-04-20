/**
 * Apply the trained taste projection head to every stored FashionCLIP
 * vector and upsert the result into a new Pinecone namespace ("taste").
 *
 * The point: at query time we can now do a taste-aware search by (a) loading
 * the same W into lib/taste-head.ts, (b) projecting the query vector through
 * it, then (c) running a Pinecone query against the `taste` namespace.
 * Because every product vector has been projected with the same W, cosine
 * similarity in this namespace reflects the Vitrine-trained taste signal.
 *
 * Prereqs: run scripts/train-taste-head.mjs first so lib/taste-head.json exists.
 *
 * Run:
 *   PINECONE_API_KEY=<key> node scripts/apply-taste-head.mjs
 *     Options:
 *       --source <ns>    source namespace to project from. Defaults to the
 *                        default (visual) namespace.
 *       --target <ns>    destination namespace. Default: "taste".
 *       --dry-run        don't upsert; just report counts.
 */

import { Pinecone } from "@pinecone-database/pinecone";
import { readFileSync, existsSync } from "fs";
import path from "path";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v == null || v.startsWith("--")) return fallback;
  return v;
}

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX   = process.env.PINECONE_INDEX ?? "muse";
const SOURCE_NS        = flag("source", "");     // "" = default visual
const TARGET_NS        = flag("target", "taste");
const DRY_RUN          = args.includes("--dry-run");

const HEAD_FILE  = path.resolve("lib/taste-head.json");
const CHUNK      = 100;      // Pinecone fetch limit per call
const UPSERT     = 100;

if (!PINECONE_API_KEY) { console.error("Missing PINECONE_API_KEY"); process.exit(1); }
if (!existsSync(HEAD_FILE)) { console.error(`Missing ${HEAD_FILE} — run scripts/train-taste-head.mjs first`); process.exit(1); }

const head = JSON.parse(readFileSync(HEAD_FILE, "utf8"));
const D = head.dim;
const Wraw = head.W;
if (!Array.isArray(Wraw) || Wraw.length !== D * D) { console.error("Bad taste-head.json shape"); process.exit(1); }
// Promote to Float32Array so V8's hot loop doesn't box/unbox through the
// regular Array path. 84K × 512² multiplications is ~22 billion ops; the
// 5× JIT speedup from typed arrays takes this from ~100 min to under 20.
const W = new Float32Array(Wraw);
console.log(`Loaded taste head: D=${D}, trained ${head.trainedAt}, acc=${(head.accuracy * 100).toFixed(1)}%`);

function applyW(x) {
  const xf = x instanceof Float32Array ? x : Float32Array.from(x);
  const y = new Float32Array(D);
  for (let i = 0; i < D; i++) {
    let s = 0;
    const base = i * D;
    for (let j = 0; j < D; j++) s += W[base + j] * xf[j];
    y[i] = s;
  }
  let n = 0;
  for (let i = 0; i < D; i++) n += y[i] * y[i];
  n = Math.sqrt(n) || 1;
  // Pinecone's client accepts arrays; use a regular array for the payload.
  const out = new Array(D);
  for (let i = 0; i < D; i++) out[i] = y[i] / n;
  return out;
}

const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
const idx = pc.index(PINECONE_INDEX);
const src = SOURCE_NS ? idx.namespace(SOURCE_NS) : idx;
const dst = idx.namespace(TARGET_NS);

// Pinecone has no "listIds" over a whole namespace for v7, but we can paginate
// via listPaginated if available; fall back to using the log's candidate_ids
// as a seed set.
async function listAllIds() {
  if (typeof src.listPaginated !== "function") {
    console.warn("listPaginated not supported — projecting from curation-log IDs only.");
    const logPath = path.resolve("data/curation-log.jsonl");
    if (!existsSync(logPath)) { console.error("No curation log fallback either."); process.exit(1); }
    const ids = new Set();
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        for (const id of r.candidate_ids ?? []) ids.add(id);
      } catch {}
    }
    return Array.from(ids);
  }
  const all = [];
  let token;
  do {
    const res = await src.listPaginated({ paginationToken: token });
    for (const v of res.vectors ?? []) all.push(v.id);
    token = res.pagination?.next;
    process.stdout.write(`\r  enumerated ${all.length.toLocaleString()} ids`);
  } while (token);
  console.log();
  return all;
}

console.log(`\n1. Enumerating vector IDs in source namespace "${SOURCE_NS || "default"}"…`);
const ids = await listAllIds();
console.log(`   ${ids.length.toLocaleString()} total`);

if (ids.length === 0) { console.log("Nothing to project."); process.exit(0); }
if (DRY_RUN) { console.log("\n--dry-run: skipping fetch + upsert."); process.exit(0); }

console.log(`\n2. Fetching → projecting → upserting to "${TARGET_NS}"…`);
let fetched = 0, projected = 0;
for (let i = 0; i < ids.length; i += CHUNK) {
  const chunk = ids.slice(i, i + CHUNK);
  const res = await src.fetch({ ids: chunk }).catch((e) => { console.warn("  fetch err:", e.message); return null; });
  if (!res?.records) continue;

  const outputs = [];
  for (const [id, rec] of Object.entries(res.records)) {
    const v = rec?.values;
    if (!v || v.length !== D) continue;
    const y = applyW(Array.from(v));
    outputs.push({ id, values: y, metadata: rec.metadata ?? {} });
  }

  // Skip empty batches — Pinecone rejects zero-record upserts, and an entire
  // chunk of 100 IDs can legitimately be empty if their vectors were deleted
  // or stored with a different dim than D. Use the `{ records }` object form
  // to match the SDK shape used successfully in scripts/embed-with-qc.mjs.
  if (outputs.length > 0) {
    for (let k = 0; k < outputs.length; k += UPSERT) {
      const slice = outputs.slice(k, k + UPSERT);
      if (slice.length === 0) continue;
      await dst.upsert({ records: slice });
    }
  }
  fetched += chunk.length;
  projected += outputs.length;
  process.stdout.write(`\r  ${fetched}/${ids.length} queried  |  ${projected} projected+upserted`);
}
console.log(`\n\n✓ Wrote ${projected.toLocaleString()} projected vectors to namespace "${TARGET_NS}".`);
