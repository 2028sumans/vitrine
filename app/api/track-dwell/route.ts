/**
 * POST /api/track-dwell
 *
 * Persists dwell-time for a product impression. Fires from the scroll views
 * as the user moves off a card, so the row already inserted by
 * /api/track-impression (or the bulk saveImpressions call) gets its
 * dwell_ms column populated.
 *
 * Body: { userToken, sessionId, objectId, dwellMs }
 *
 * Best-effort: never throws, returns {ok:true} even on no-op so the client
 * doesn't need to handle errors. The training pipeline tolerates missing
 * dwell data (treats it as "impressed, ungraded").
 */

import { NextResponse } from "next/server";
import { updateImpressionDwell } from "@/lib/taste-memory";

export const dynamic = "force-dynamic";

interface Body {
  userToken?: string;
  sessionId?: string;
  objectId?:  string;
  dwellMs?:   number;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const userToken = typeof body.userToken === "string" ? body.userToken : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const objectId  = typeof body.objectId  === "string" ? body.objectId  : "";
  const dwellMs   = typeof body.dwellMs   === "number" ? body.dwellMs   : NaN;

  if (!userToken || !sessionId || !objectId || !Number.isFinite(dwellMs)) {
    return NextResponse.json({ ok: false, reason: "missing-fields" });
  }

  try {
    await updateImpressionDwell(userToken, sessionId, objectId, dwellMs);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Never 500 the client — logging is best-effort.
    console.warn("[track-dwell] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false });
  }
}
