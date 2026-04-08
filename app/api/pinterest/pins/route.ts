import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export interface PinData {
  id:          string;
  title:       string;
  description: string;
  imageUrl:    string;  // ~736px — sent to Claude
  thumbUrl:    string;  // ~400px — shown in UI
}

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const boardId = searchParams.get("boardId");
  if (!boardId) {
    return NextResponse.json({ error: "Missing boardId" }, { status: 400 });
  }

  const res = await fetch(
    `https://api.pinterest.com/v5/boards/${boardId}/pins?page_size=25`,
    {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) {
    console.error("Pinterest pins fetch failed:", res.status);
    return NextResponse.json({ error: "Failed to fetch pins" }, { status: res.status });
  }

  const data = await res.json();

  const pins: PinData[] = (data.items ?? [])
    .filter((pin: Record<string, unknown>) => {
      const media = pin.media as Record<string, unknown> | undefined;
      return media?.media_type === "image" && media?.images;
    })
    .slice(0, 20)
    .map((pin: Record<string, unknown>) => {
      const media  = pin.media as Record<string, Record<string, { url: string }>>;
      const images = media.images ?? {};
      // Prefer 736x for Claude quality, fall back to largest available
      const imageUrl = (images["736x"] ?? images["1200x"] ?? images["400x300"] ?? images["orig"])?.url ?? "";
      const thumbUrl = (images["400x300"] ?? images["736x"] ?? images["150x150"])?.url ?? "";

      return {
        id:          String(pin.id ?? ""),
        title:       String(pin.title ?? ""),
        description: String(pin.description ?? ""),
        imageUrl,
        thumbUrl,
      };
    })
    .filter((p: PinData) => p.imageUrl);

  return NextResponse.json({ pins });
}
