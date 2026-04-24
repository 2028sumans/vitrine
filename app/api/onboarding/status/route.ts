/**
 * GET /api/onboarding/status?userToken=<token>
 *
 * Lightweight "has this user completed the quiz yet?" endpoint.
 *
 * Used by:
 *   - The /onboarding page itself to short-circuit if the user is already done
 *     (guard against accidental re-entry — the quiz is one-shot).
 *   - The future middleware gate that redirects signed-in-but-unonboarded
 *     users into /onboarding.
 *
 * Design note: we accept the token as a query string, not a body, so the
 * call can be a plain GET — simpler to cache / prefetch / inspect than POST.
 * Server-side still uses the service-role Supabase client, so there's no
 * auth concern from passing the token in the URL.
 *
 * Response
 * --------
 *   { completed: boolean, ageRange: string | null, completedAt: string | null }
 */

import { NextResponse } from "next/server";
import { getOnboarding } from "@/lib/onboarding-memory";

export async function GET(request: Request) {
  const url       = new URL(request.url);
  const userToken = (url.searchParams.get("userToken") ?? "").trim();

  if (!userToken || userToken === "anon") {
    return NextResponse.json({ completed: false, ageRange: null, completedAt: null });
  }

  const row = await getOnboarding(userToken);
  return NextResponse.json({
    completed:   row != null,
    ageRange:    row?.ageRange    ?? null,
    completedAt: row?.completedAt ?? null,
  });
}
