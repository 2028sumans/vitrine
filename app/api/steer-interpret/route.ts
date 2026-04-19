/**
 * POST /api/steer-interpret
 *
 * Takes a user's free-text Steer instruction ("cheaper", "no florals",
 * "more minimalist blazers") and returns a structured SteerInterpretation
 * the client can then pass to /api/shop-all. The client calls this once
 * on submit and caches the result for subsequent pagination.
 *
 * See lib/steer-interpret.ts for the Claude prompt and output shape.
 */

import { NextResponse }       from "next/server";
import { interpretSteerText } from "@/lib/steer-interpret";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!text) {
    return NextResponse.json({
      search_terms: [], avoid_terms: [], price_range: null,
      categories: [], colors: [], intent: "",
    });
  }

  const interp = await interpretSteerText(text);
  return NextResponse.json(interp);
}
