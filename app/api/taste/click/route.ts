import { NextResponse } from "next/server";
import { saveClickSignal } from "@/lib/taste-memory";
import { bumpLatestSteerOutcome } from "@/lib/steer-history";

export async function POST(request: Request) {
  try {
    const { userToken, product, outcome } = await request.json();

    if (!userToken || !product?.objectID) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    await saveClickSignal(userToken, product);

    // Steer telemetry — credit the user's most recent steer (within the
    // last 30 min) when they save or dismiss something. Used to score
    // which interpretations actually convert; surfaces in future prompt
    // tuning. Treat anything other than explicit "dismiss" as a positive
    // outcome since clicks default to interest.
    if (outcome === "save" || outcome === "dismiss") {
      void bumpLatestSteerOutcome(userToken, outcome);
    } else {
      // No explicit outcome on the request — default to "save" since the
      // existing call-sites only fire this route on positive interactions
      // (save / heart). We can refine later if needed.
      void bumpLatestSteerOutcome(userToken, "save");
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Non-fatal — click tracking should never surface to the user
    console.warn("Click signal save failed:", err);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
