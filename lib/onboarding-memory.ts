/**
 * Supabase CRUD for the `user_onboarding` table.
 *
 * Table schema in supabase/migrations/20260424_user_onboarding.sql:
 *   user_token       text primary key
 *   age_range        text not null    -- "age-13-18" | "age-18-25" | …
 *   upload_centroid  jsonb            -- 512-dim float[]
 *   upload_vectors   jsonb            -- raw per-image vectors (array of 512-dim float[])
 *   completed_at     timestamptz
 *   updated_at       timestamptz
 *
 * All functions fail silently on "table does not exist" so a dev running
 * locally without the migration applied still gets a working app (onboarding
 * just appears un-completed forever, which is fine for debugging).
 */

import { getServiceSupabase } from "@/lib/supabase";

// Stable set of valid age-range keys. If you add a bucket in the quiz UI,
// add it here too — the save route rejects anything not in this list.
export const AGE_RANGE_KEYS = [
  "age-13-18",
  "age-18-25",
  "age-25-32",
  "age-32-40",
  "age-40-60",
] as const;

export type AgeRangeKey = typeof AGE_RANGE_KEYS[number];

export interface OnboardingRecord {
  userToken:       string;
  ageRange:        AgeRangeKey;
  uploadCentroid:  number[] | null;
  uploadVectors:   number[][];
  completedAt:     string; // ISO timestamp
}

/**
 * Upsert a user's onboarding answers. Overwrites any previous row for the
 * same user_token (quiz is one-shot, so in practice this only runs once).
 */
export async function saveOnboarding(args: {
  userToken:       string;
  ageRange:        AgeRangeKey;
  uploadCentroid:  number[] | null;
  uploadVectors:   number[][];
}): Promise<void> {
  const { userToken, ageRange, uploadCentroid, uploadVectors } = args;
  if (!userToken || userToken === "anon") return;
  try {
    const sb = getServiceSupabase();
    const now = new Date().toISOString();
    await sb.from("user_onboarding").upsert(
      {
        user_token:       userToken,
        age_range:        ageRange,
        upload_centroid:  uploadCentroid,
        upload_vectors:   uploadVectors,
        completed_at:     now,
        updated_at:       now,
      },
      { onConflict: "user_token" },
    );
  } catch (err) {
    // Table may not exist yet (dev box without migrations applied).
    console.warn("[onboarding] save failed (non-fatal):", err instanceof Error ? err.message : err);
  }
}

/**
 * Fetch a user's onboarding row. Returns null if:
 *   - The user hasn't completed onboarding
 *   - The user_token is missing / "anon"
 *   - Supabase errors (table missing, network flake, etc.)
 *
 * Safe to call on every request — Supabase handles its own connection pool.
 * If you find you're calling this hot-path, memoize upstream.
 */
export async function getOnboarding(userToken: string): Promise<OnboardingRecord | null> {
  if (!userToken || userToken === "anon") return null;
  try {
    const sb = getServiceSupabase();
    const { data, error } = await sb
      .from("user_onboarding")
      .select("user_token, age_range, upload_centroid, upload_vectors, completed_at")
      .eq("user_token", userToken)
      .maybeSingle();
    if (error || !data) return null;
    return {
      userToken:      data.user_token as string,
      ageRange:       data.age_range  as AgeRangeKey,
      uploadCentroid: (data.upload_centroid as number[] | null) ?? null,
      uploadVectors:  (data.upload_vectors  as number[][]    | null) ?? [],
      completedAt:    data.completed_at as string,
    };
  } catch {
    return null;
  }
}

/**
 * Cheap "has the user completed onboarding?" check. Returns false on any
 * failure path so the middleware / gate doesn't accidentally lock a user
 * out of the app because Supabase hiccupped.
 */
export async function hasCompletedOnboarding(userToken: string): Promise<boolean> {
  const row = await getOnboarding(userToken);
  return row != null;
}

/** Runtime guard — validates an arbitrary string against the age enum. */
export function isAgeRangeKey(v: unknown): v is AgeRangeKey {
  return typeof v === "string" && (AGE_RANGE_KEYS as readonly string[]).includes(v);
}
