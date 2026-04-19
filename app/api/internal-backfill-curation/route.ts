/**
 * INTERNAL — backfill the curation log from historical StyleDNAs in Supabase.
 *
 * For each stored DNA we rerun the same candidate-fetch + curateProducts
 * pipeline that runs in the live /api/curate flow, but with no board images.
 * The KEEP / REJECT split still gets recorded via logCuration, populating
 * data/curation-log.jsonl with real data from users who ran the flow before
 * the logger existed.
 *
 * Contract:
 *   POST { limit: number, offset: number, secret: string }
 *   → { processed: number, failed: number, results: [{userToken, boardName, keptCount, rejectedCount, error?}] }
 *
 * Guards:
 *   - BACKFILL_SECRET env var must match the `secret` body field, OR the
 *     request is rejected. Set it in .env.local for local use; do not
 *     deploy this route to production without also setting the secret.
 */

import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase";
import { curateProducts, fetchCandidateProductsByCategory, filterByAvoids, filterMensItems } from "@/lib/ai";
import type { StyleDNA } from "@/lib/types";

// A single curateProducts call against Claude Sonnet + Algolia/Pinecone runs
// ~8–12s. We cap per-request processing to keep Next.js route budgets sane
// and let the driver script checkpoint frequently.
export const maxDuration = 300;
export const dynamic     = "force-dynamic";

interface Body {
  limit?:   number;
  offset?:  number;
  secret?:  string;
  /**
   * Case-insensitive substrings. Any DNA whose board_name contains one of
   * these is skipped (not re-curated, not logged). Use for holiday/novelty
   * boards that don't reflect the user's durable taste — e.g. "christmas",
   * "halloween costume".
   */
  exclude?: string[];
}

export async function POST(request: Request) {
  const body: Body = await request.json().catch(() => ({}));
  const limit   = Math.max(1, Math.min(20, Number(body.limit  ?? 5)));
  const offset  = Math.max(0, Number(body.offset ?? 0));
  const secret  = typeof body.secret === "string" ? body.secret : "";
  const expected = process.env.BACKFILL_SECRET ?? "";
  const exclude = Array.isArray(body.exclude)
    ? body.exclude.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.toLowerCase().trim())
    : [];

  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 1. Page through user_style_dnas in deterministic created_at DESC order
  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from("user_style_dnas")
    .select("id, user_token, board_name, style_dna, created_at")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as Array<{
    id:          string;
    user_token:  string;
    board_name:  string;
    style_dna:   StyleDNA | null;
    created_at:  string;
  }>;

  const results: Array<{
    userToken:     string;
    boardName:     string;
    keptCount:     number;
    rejectedCount: number;
    skipped?:      boolean;
    error?:        string;
  }> = [];

  for (const row of rows) {
    const dna = row.style_dna;
    if (!dna) {
      results.push({ userToken: row.user_token, boardName: row.board_name, keptCount: 0, rejectedCount: 0, error: "no-dna" });
      continue;
    }

    // Exclude filter — novelty/seasonal boards that would poison training
    // data with out-of-distribution KEEP/REJECT pairs.
    const boardLower = (row.board_name ?? "").toLowerCase();
    const hit = exclude.find((term) => boardLower.includes(term));
    if (hit) {
      results.push({ userToken: row.user_token, boardName: row.board_name, keptCount: 0, rejectedCount: 0, skipped: true, error: `excluded (${hit})` });
      continue;
    }

    try {
      // Match the live flow: fetch → avoid-filter → men-filter → curate.
      // Board images intentionally empty — the keep/reject signal is still
      // real judgment data, just with slightly less context than live.
      const candidates = await fetchCandidateProductsByCategory(dna, row.user_token);
      const noAvoids   = filterByAvoids(candidates, dna.avoids ?? []);
      const filtered   = filterMensItems(noAvoids);
      const curated    = await curateProducts(dna, filtered, [], []);

      const candidateIds = (["dress","top","bottom","jacket","shoes","bag"] as const)
        .flatMap((c) => filtered[c].map((p) => p.objectID));
      const keptCount    = curated.products.length;
      const rejectedCount = Math.max(0, candidateIds.length - keptCount);
      results.push({ userToken: row.user_token, boardName: row.board_name, keptCount, rejectedCount });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ userToken: row.user_token, boardName: row.board_name, keptCount: 0, rejectedCount: 0, error: msg });
    }
  }

  return NextResponse.json({
    processed: results.filter((r) => !r.error && !r.skipped).length,
    failed:    results.filter((r) =>  r.error && !r.skipped).length,
    skipped:   results.filter((r) =>  r.skipped).length,
    offset,
    returned:  rows.length,
    results,
  });
}
