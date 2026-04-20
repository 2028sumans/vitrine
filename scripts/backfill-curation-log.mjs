/**
 * Driver for the /api/internal-backfill-curation route.
 *
 * Loops through every StyleDNA stored in Supabase (oldest → newest) and
 * re-runs the curate pipeline against each, which triggers the logCuration
 * hook inside lib/ai.ts and appends one JSONL row per DNA to
 * data/curation-log.jsonl.
 *
 * Run:
 *   1. Start the dev server (npm run dev) so the internal route is reachable.
 *   2. Make sure BACKFILL_SECRET is set in .env.local.
 *   3. node scripts/backfill-curation-log.mjs
 *
 * Flags:
 *   --base <url>     default http://localhost:3000
 *   --page-size <N>  DNAs processed per request. Default 5. Max 20.
 *   --max <N>        cap total DNAs processed. Default Infinity.
 *   --start <N>      starting offset (resume). Default 0.
 *   --secret <str>   override the BACKFILL_SECRET env var.
 *
 * Cost warning: each DNA triggers one Claude Sonnet 4.6 call (~$0.05–$0.10)
 * plus Algolia/Pinecone queries. 50 DNAs ≈ $3, 500 ≈ $30. Worth running on
 * a sample first (--max 10) to confirm rows land in the log.
 */

import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import readline from "readline";

// ── Config ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v == null || v.startsWith("--")) return fallback;
  return v;
}

const BASE      = flag("base", "http://localhost:3000");
const PAGE_SIZE = Math.max(1, Math.min(20, Number(flag("page-size", 5))));
const MAX       = Number(flag("max", Infinity));
const START     = Math.max(0, Number(flag("start", 0)));
const SECRET    = flag("secret", process.env.BACKFILL_SECRET ?? readSecretFromEnvFile());
const LOG_FILE  = path.resolve("data/curation-log.jsonl");

// Boards whose name (case-insensitive substring) indicates novelty/holiday
// intent — not durable taste. These get skipped at the route layer.
// Override with --exclude "term1,term2".
const EXCLUDE_ARG = flag("exclude", "christmas");
const EXCLUDE     = String(EXCLUDE_ARG).split(",").map((s) => s.trim()).filter(Boolean);

function readSecretFromEnvFile() {
  try {
    const raw = readFileSync(".env.local", "utf8");
    const m = raw.match(/^BACKFILL_SECRET=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}

if (!SECRET) {
  console.error("Missing BACKFILL_SECRET (set in .env.local or pass --secret). Aborting.");
  process.exit(1);
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}

// ── Preflight: ensure server is up ────────────────────────────────────────────

async function pingServer() {
  try {
    // Use limit=0-ish behavior by pointing at an offset past the table.
    // The route caps limit at 1 minimum, but we only care that it returns 200
    // and doesn't burn a Claude call — so we pass a huge offset so no rows
    // come back.
    const res = await fetch(`${BASE}/api/internal-backfill-curation`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ limit: 1, offset: 1_000_000, secret: SECRET, exclude: EXCLUDE }),
    });
    if (res.status === 403) { console.error("  ✗ Route rejected the secret (403). Check .env.local matches."); return false; }
    if (!res.ok)             { console.error("  ✗ Route responded", res.status); return false; }
    return true;
  } catch (e) {
    console.error(`  ✗ Could not reach ${BASE} — is npm run dev running?  (${e.message})`);
    return false;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Backfill curation log`);
  console.log(`  base=${BASE}  page-size=${PAGE_SIZE}  start=${START}  max=${MAX}`);
  console.log(`  exclude=${EXCLUDE.length ? EXCLUDE.join(", ") : "(none)"}\n`);
  console.log(`Preflight: ${BASE}/api/internal-backfill-curation…`);
  const startLines = countLogLines();
  console.log(`  Current curation log rows: ${startLines}\n`);

  const ok = await pingServer();
  if (!ok) process.exit(1);
  console.log("  ✓ Server reachable.\n");

  // The preflight hit offset=1_000_000 (past the table), so it never
  // re-curated a real row and the log is untouched. Start exactly where
  // the user asked.
  if (process.stdout.isTTY) {
    const a = await ask(`Proceed with backfill starting at offset ${START}? Each DNA costs ~$0.05 in Claude API. Type "yes": `);
    if (a.trim().toLowerCase() !== "yes") { console.log("Cancelled."); return; }
  }

  let offset = START;
  let processed = 0, failed = 0, skipped = 0;
  const t0 = Date.now();

  while (processed + failed < MAX) {
    const limit = Math.min(PAGE_SIZE, MAX - processed - failed);
    if (limit <= 0) break;

    const res = await fetch(`${BASE}/api/internal-backfill-curation`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ limit, offset, secret: SECRET, exclude: EXCLUDE }),
    }).catch((e) => { console.error("  request error:", e.message); return null; });

    if (!res) { break; }
    if (!res.ok) { console.error(`  HTTP ${res.status} — stopping.`); break; }

    const data = await res.json();
    const rows = data.results ?? [];
    processed += data.processed ?? 0;
    failed    += data.failed    ?? 0;
    skipped   += data.skipped   ?? 0;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `[+${elapsed}s] offset=${offset}  returned=${rows.length}  ` +
      `ok=${data.processed ?? 0}  fail=${data.failed ?? 0}  skip=${data.skipped ?? 0}  ` +
      `total_ok=${processed}  total_fail=${failed}  total_skip=${skipped}`
    );

    for (const r of rows) {
      const tag = r.skipped ? "  ·" : r.error ? "  ✗" : "  ✓";
      const summary = r.skipped
        ? `skipped (${r.error})`
        : r.error
          ? `error: ${r.error}`
          : `kept=${r.keptCount}  rejected=${r.rejectedCount}`;
      console.log(`${tag} ${r.boardName?.slice(0, 40).padEnd(40)} ${summary}`);
    }

    if (rows.length < limit) { console.log("\n  (reached end of Supabase DNA table)"); break; }
    offset += rows.length;
  }

  const endLines = countLogLines();
  const delta    = endLines - startLines;
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
  console.log(`  Supabase DNAs processed OK: ${processed}`);
  console.log(`  Supabase DNAs failed:       ${failed}`);
  console.log(`  Supabase DNAs skipped:      ${skipped}${EXCLUDE.length ? `  (exclude=${EXCLUDE.join(",")})` : ""}`);
  console.log(`  Curation log rows written:  ${delta}  (now ${endLines} total)`);
  console.log(`\nNext: node scripts/train-taste-head.mjs`);
}

function countLogLines() {
  if (!existsSync(LOG_FILE)) return 0;
  try {
    if (statSync(LOG_FILE).size === 0) return 0;
    return readFileSync(LOG_FILE, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch { return 0; }
}

main().catch((e) => { console.error(e); process.exit(1); });
