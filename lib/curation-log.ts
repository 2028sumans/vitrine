/**
 * Curation decision logger — persists KEEP / REJECT labels from curateProducts
 * so we can train a taste-aware projection head on top of FashionCLIP later.
 *
 * Each curate call produces one JSONL row capturing:
 *   - a stable hash of the StyleDNA (so different boards sharing the same
 *     aesthetic vocabulary can be grouped during training),
 *   - which product objectIDs were candidates and which survived,
 *   - a short textual summary of the aesthetic for human inspection.
 *
 * No PII is logged. All data is append-only; training reads the file fresh.
 *
 * Storage: JSONL at data/curation-log.jsonl. Kept out of Algolia/Pinecone on
 * purpose — this is training data, not query-path state, and plaintext JSONL
 * is what the training script consumes directly. When the file gets large
 * (> a few hundred MB) we can rotate or migrate to Supabase.
 */

import { appendFile, mkdir } from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { StyleDNA } from "@/lib/types";

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

  void (async () => {
    try {
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      // Never throw — logging failures must not break the curation response.
      console.warn("[curation-log] append failed:", err instanceof Error ? err.message : err);
    }
  })();
}

export const CURATION_LOG_PATH = LOG_FILE;
