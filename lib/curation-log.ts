/**
 * Curation decision logger — persists KEEP / REJECT labels from curateProducts
 * so we can train a taste-aware projection head on top of FashionCLIP later.
 *
 * Storage: Supabase `curation_logs` table is the source of truth (durable
 * across Vercel serverless invocations; JSONL on local disk would be a no-op
 * in prod). We also write to data/curation-log.jsonl when running locally so
 * development and ad-hoc analysis don't need DB access. Both writes are
 * fire-and-forget so logging failures never surface to the user.
 *
 * Schema: see supabase/migrations/20260420_curation_logs.sql — columns mirror
 * CurationLogEntry below. Training reads fresh from Supabase on each run.
 *
 * No PII is logged.
 */

import { appendFile, mkdir } from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { StyleDNA } from "@/lib/types";
import { getServiceSupabase } from "@/lib/supabase";

const LOG_DIR  = path.resolve(process.cwd(), "data");
const LOG_FILE = path.join(LOG_DIR, "curation-log.jsonl");

export interface CurationLogEntry {
  ts:              string;        // ISO timestamp
  dna_hash:        string;        // sha1 of primary+secondary aesthetic + summary
  dna_summary:     string;        // short human-readable summary
  primary:         string;        // primary aesthetic
  secondary:       string;        // secondary aesthetic
  price_range:     string;        // budget | mid | luxury
  candidate_ids:   string[];      // every product considered this run
  kept_ids:        string[];      // product IDs that Claude selected
  rejected_ids:    string[];      // candidate_ids minus kept_ids (convenience)
  board_image_urls: string[];     // up to 8 board image URLs (for re-embedding at training time)
}

function hashDNA(dna: StyleDNA): string {
  const key = [
    dna.primary_aesthetic ?? "",
    dna.secondary_aesthetic ?? "",
    (dna.color_palette ?? []).slice(0, 5).join(","),
    (dna.silhouettes   ?? []).slice(0, 3).join(","),
    dna.summary ?? "",
  ].join("|").toLowerCase();
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/**
 * Append one curation decision to the log. Fire-and-forget — callers do not
 * await this in hot paths (latency for the user is what matters), but we
 * preserve errors via .catch so they surface in server logs if the disk is
 * full or the path is unwritable.
 */
export function logCuration(args: {
  dna:              StyleDNA;
  candidateIds:     string[];
  keptIds:          string[];
  boardImageUrls?:  string[];
}): void {
  const { dna, candidateIds, keptIds, boardImageUrls = [] } = args;

  const kept    = new Set(keptIds);
  const entry: CurationLogEntry = {
    ts:               new Date().toISOString(),
    dna_hash:         hashDNA(dna),
    dna_summary:      (dna.summary ?? "").slice(0, 240),
    primary:          dna.primary_aesthetic ?? "",
    secondary:        dna.secondary_aesthetic ?? "",
    price_range:      dna.price_range ?? "mid",
    candidate_ids:    candidateIds,
    kept_ids:         keptIds,
    rejected_ids:     candidateIds.filter((id) => !kept.has(id)),
    board_image_urls: boardImageUrls.slice(0, 8),
  };

  // Supabase write — source of truth in prod. Ignore failures silently; the
  // training pipeline is resilient to missing rows.
  void (async () => {
    try {
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
      const sb = getServiceSupabase();
      const { error } = await sb.from("curation_logs").insert({
        dna_hash:            entry.dna_hash,
        dna_summary:         entry.dna_summary,
        primary_aesthetic:   entry.primary,
        secondary_aesthetic: entry.secondary,
        price_range:         entry.price_range,
        candidate_ids:       entry.candidate_ids,
        kept_ids:            entry.kept_ids,
        rejected_ids:        entry.rejected_ids,
        board_image_urls:    entry.board_image_urls,
      });
      if (error) console.warn("[curation-log] supabase insert failed:", error.message);
    } catch (err) {
      console.warn("[curation-log] supabase write threw:", err instanceof Error ? err.message : err);
    }
  })();

  // Local-dev JSONL mirror — useful when iterating on the training script
  // without going through Supabase. Silently skipped in serverless prod
  // where the working directory is read-only.
  void (async () => {
    try {
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      /* read-only FS in prod — ignore */
    }
  })();
}

export const CURATION_LOG_PATH = LOG_FILE;
