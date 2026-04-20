/**
 * One-shot: import existing data/curation-log.jsonl rows into Supabase.
 *
 * Run this once after applying the 20260420_curation_logs.sql migration to
 * move historical local-dev rows into the durable store. The live logger
 * (lib/curation-log.ts) writes directly to Supabase from here on.
 *
 * Idempotent-ish: we don't dedupe on import — running twice will double the
 * rows. Intended for a single manual bootstrap.
 *
 * Run:
 *   SUPABASE_SERVICE_ROLE_KEY=<key> NEXT_PUBLIC_SUPABASE_URL=<url> \
 *     node scripts/import-curation-log-to-supabase.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";

const LOG_FILE = path.resolve("data/curation-log.jsonl");

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!existsSync(LOG_FILE)) {
  console.error(`No JSONL at ${LOG_FILE} — nothing to import.`);
  process.exit(0);
}

const rows = readFileSync(LOG_FILE, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

console.log(`Read ${rows.length} rows from ${LOG_FILE}`);
if (rows.length === 0) process.exit(0);

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const payload = rows.map((r) => ({
  created_at:          r.ts ?? new Date().toISOString(),
  dna_hash:            r.dna_hash ?? "",
  dna_summary:         r.dna_summary ?? "",
  primary_aesthetic:   r.primary ?? "",
  secondary_aesthetic: r.secondary ?? "",
  price_range:         r.price_range ?? "mid",
  candidate_ids:       r.candidate_ids ?? [],
  kept_ids:            r.kept_ids ?? [],
  rejected_ids:        r.rejected_ids ?? [],
  board_image_urls:    r.board_image_urls ?? [],
}));

const BATCH = 500;
let inserted = 0;
for (let i = 0; i < payload.length; i += BATCH) {
  const chunk = payload.slice(i, i + BATCH);
  const { error } = await sb.from("curation_logs").insert(chunk);
  if (error) { console.error("Insert error:", error.message); process.exit(1); }
  inserted += chunk.length;
  console.log(`  ${inserted}/${payload.length} inserted`);
}
console.log(`\n✓ Imported ${inserted} rows into curation_logs.`);
