import { NextResponse } from "next/server";
import { saveClickSignal } from "@/lib/taste-memory";

export async function POST(request: Request) {
  try {
    const { userToken, product } = await request.json();

    if (!userToken || !product?.objectID) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    await saveClickSignal(userToken, product);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Non-fatal — click tracking should never surface to the user
    console.warn("Click signal save failed:", err);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
