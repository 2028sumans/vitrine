/**
 * POST /api/steer-interpret
 *
 * Takes a user's free-text Steer instruction ("cheaper", "no florals",
 * "more minimalist blazers") and returns a structured SteerInterpretation
 * the client can then pass to /api/shop-all. The client calls this once
 * on submit and caches the result for subsequent pagination.
 *
 * See lib/steer-interpret.ts for the Claude prompt and output shape.
 *
 * Side effect: appends the steer to user_steer_history (lib/steer-history)
 * so we can:
 *   - Show "you previously asked for X" in UI
 *   - Re-prompt Claude with last K steers for coreference resolution
 *   - Track which interpretations correlate with saves vs dismisses
 *
 * The append is fire-and-forget — never blocks the response.
 */

import { NextResponse }                  from "next/server";
import { interpretSteerText }            from "@/lib/steer-interpret";
import { appendSteerHistory, recentSteerHistory } from "@/lib/steer-history";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const userToken    = typeof body?.userToken === "string" ? body.userToken.trim() : "";
  const categorySlug = typeof body?.categorySlug === "string" ? body.categorySlug.trim() || null : null;

  if (!text) {
    return NextResponse.json({
      search_terms: [], avoid_terms: [], price_range: null,
      categories: [], colors: [], style_axes: {}, intent: "",
    });
  }

  // Pull the user's last 3 steers (in this category if scoped, else any)
  // so Claude can resolve coreferences like "more like the last one I
  // liked" or "less of what I asked for before". Empty array for anon /
  // first-timer; the prompt handles that gracefully.
  const recent = userToken
    ? await recentSteerHistory(userToken, { limit: 3, categorySlug })
    : [];
  const recentTexts = recent.map((r) => r.rawText).filter(Boolean);

  const interp = await interpretSteerText(text, { recentSteers: recentTexts });

  // Fire-and-forget append. We don't await — the user has their result.
  void appendSteerHistory({ userToken, rawText: text, interp, categorySlug });

  return NextResponse.json(interp);
}
