/**
 * Supabase CRUD for the `user_steer_history` table.
 *
 * Every Steer submission is appended; reads usually pull the last N for a
 * given user (sometimes scoped to a category). All operations fail silently
 * on table-missing / network errors so a Supabase outage can't take down
 * the steer flow itself — we'd rather lose telemetry than refuse to refine
 * a feed.
 *
 * Schema in supabase/migrations/20260425_steer_history.sql:
 *   id, user_token, raw_text, interp JSONB, category_slug, outcome_saves,
 *   outcome_dismisses, created_at
 */

import { getServiceSupabase } from "@/lib/supabase";
import type { SteerInterpretation } from "@/lib/steer-interpret";

export interface SteerHistoryRow {
  id:               number;
  userToken:        string;
  rawText:          string;
  interp:           SteerInterpretation;
  categorySlug:     string | null;
  outcomeSaves:     number;
  outcomeDismisses: number;
  createdAt:        string;
}

/**
 * Append a steer submission. Fire-and-forget — caller should not await
 * for UX purposes; the steer-interpret round-trip is the user-visible
 * latency, this just logs the result.
 */
export async function appendSteerHistory(args: {
  userToken:    string;
  rawText:      string;
  interp:       SteerInterpretation;
  categorySlug?: string | null;
}): Promise<void> {
  const { userToken, rawText, interp } = args;
  if (!userToken || userToken === "anon") return;
  if (!rawText.trim()) return;
  try {
    const sb = getServiceSupabase();
    await sb.from("user_steer_history").insert({
      user_token:    userToken,
      raw_text:      rawText.slice(0, 500), // hard cap; real input is short
      interp,
      category_slug: args.categorySlug ?? null,
    });
  } catch (err) {
    console.warn("[steer-history] append failed (non-fatal):", err instanceof Error ? err.message : err);
  }
}

/**
 * Fetch the most recent N steers for a user, optionally filtered by the
 * category they were in when they typed it. Most-recent-first.
 *
 * Empty user_token / "anon" → empty array (no DB call).
 */
export async function recentSteerHistory(
  userToken: string,
  options:   { limit?: number; categorySlug?: string | null } = {},
): Promise<SteerHistoryRow[]> {
  if (!userToken || userToken === "anon") return [];
  const limit = options.limit ?? 5;
  try {
    const sb = getServiceSupabase();
    let q = sb
      .from("user_steer_history")
      .select("id, user_token, raw_text, interp, category_slug, outcome_saves, outcome_dismisses, created_at")
      .eq("user_token", userToken)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (options.categorySlug) {
      q = q.eq("category_slug", options.categorySlug);
    }
    const { data, error } = await q;
    if (error || !data) return [];
    return data.map((r) => ({
      id:               r.id as number,
      userToken:        r.user_token as string,
      rawText:          r.raw_text as string,
      interp:           r.interp as SteerInterpretation,
      categorySlug:     r.category_slug as string | null,
      outcomeSaves:     (r.outcome_saves     as number) ?? 0,
      outcomeDismisses: (r.outcome_dismisses as number) ?? 0,
      createdAt:        r.created_at as string,
    }));
  } catch {
    return [];
  }
}

/**
 * Bump the outcome counter on the user's MOST RECENT steer (saves or
 * dismisses). Called by /api/taste/click + /api/saves on each interaction.
 *
 * "Most recent" rather than "all recent" because a save 30 minutes after
 * the steer is unlikely to be caused by the steer. We only credit the
 * latest steer.
 */
export async function bumpLatestSteerOutcome(
  userToken: string,
  outcome:   "save" | "dismiss",
): Promise<void> {
  if (!userToken || userToken === "anon") return;
  try {
    const sb = getServiceSupabase();
    const { data: rows } = await sb
      .from("user_steer_history")
      .select("id, outcome_saves, outcome_dismisses, created_at")
      .eq("user_token", userToken)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = rows?.[0];
    if (!row) return;
    // Time-bound: only credit steers from the last 30 minutes — older steers
    // are stale, the user has moved on conceptually.
    const ageMs = Date.now() - new Date(row.created_at as string).getTime();
    if (ageMs > 30 * 60 * 1000) return;

    const field = outcome === "save" ? "outcome_saves" : "outcome_dismisses";
    const next  = ((row as Record<string, number>)[field] ?? 0) + 1;
    await sb
      .from("user_steer_history")
      .update({ [field]: next })
      .eq("id", row.id as number);
  } catch {
    // Best-effort; never block the user-visible interaction on telemetry.
  }
}
