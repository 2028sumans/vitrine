/**
 * Sanity-checks the Pinecone index:
 * 1. How many vectors are stored
 * 2. Fetches 10 random vectors and verifies they're diverse (not copies)
 * 3. Computes cosine similarity between random pairs — should be 0.1–0.7, not 1.0
 */

import { Pinecone }    from "@pinecone-database/pinecone";
import { readFileSync } from "fs";

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX   = process.env.PINECONE_INDEX ?? "muse-products";
const CHECKPOINT_FILE  = "scripts/embed-checkpoint.json";

if (!PINECONE_API_KEY) { console.error("Missing PINECONE_API_KEY"); process.exit(1); }

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a) { return Math.sqrt(dot(a, a)); }
function cosine(a, b) { const n = norm(a) * norm(b); return n === 0 ? 0 : dot(a, b) / n; }

async function main() {
  const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
  const index    = pinecone.index(PINECONE_INDEX);

  // 1. Index stats
  const stats = await index.describeIndexStats();
  console.log("── Index stats ──────────────────────────────");
  console.log(`  Total vectors : ${stats.totalRecordCount ?? stats.totalVectorCount ?? "?"}`);
  console.log(`  Dimension     : ${stats.dimension}`);
  console.log(`  Namespaces    : ${JSON.stringify(stats.namespaces)}`);

  // 2. Pick 10 random IDs from checkpoint
  const { done } = JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8"));
  console.log(`\n── Checkpoint ───────────────────────────────`);
  console.log(`  Checkpointed  : ${done.length} product IDs`);

  const sample = done.sort(() => Math.random() - 0.5).slice(0, 10);
  console.log(`  Sampling IDs  : ${sample.join(", ")}`);

  // 3. Fetch those vectors
  const fetched = await index.fetch({ ids: sample });
  const records = Object.values(fetched.records ?? fetched.vectors ?? {});
  console.log(`\n── Fetched ${records.length} vectors ────────────────────`);

  if (records.length === 0) {
    console.log("  ✗ No vectors returned — IDs may not be in Pinecone");
    return;
  }

  for (const rec of records) {
    const v    = rec.values;
    const nnan = v.filter((x) => !Number.isFinite(x)).length;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const mn   = Math.min(...v);
    const mx   = Math.max(...v);
    console.log(`  ${rec.id.padEnd(12)} dim=${v.length}  mean=${mean.toFixed(4)}  min=${mn.toFixed(4)}  max=${mx.toFixed(4)}  nan=${nnan}`);
  }

  // 4. Pairwise cosine similarities — should NOT all be 1.0
  console.log("\n── Pairwise cosine similarities (should be 0.1–0.8, NOT 1.0) ──");
  let allSame = true;
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const sim = cosine(records[i].values, records[j].values);
      const flag = sim > 0.999 ? " ← ✗ DUPLICATE?" : sim < 0.05 ? " ← low" : "";
      if (sim < 0.999) allSame = false;
      console.log(`  ${records[i].id} ↔ ${records[j].id}  sim=${sim.toFixed(4)}${flag}`);
    }
  }

  console.log("\n── Verdict ──────────────────────────────────");
  if (allSame) {
    console.log("  ✗ ALL similarities are 1.0 — embeddings look like duplicates!");
  } else {
    console.log("  ✓ Embeddings are diverse — looks good!");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
