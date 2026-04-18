import { NextRequest, NextResponse } from "next/server";

export interface PinData {
  id:          string;
  title:       string;
  description: string;
  imageUrl:    string;
  thumbUrl:    string;
  altText?:    string;     // Pinterest accessibility text — often richer than title/description
  link?:       string;     // source URL (vogue.com, ssense.com, etc. — style tribe signal)
  domain?:     string;     // hostname extracted from link
  dominantColors?: string[]; // Pinterest pre-computed hex colors
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const accessToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const boardId = searchParams.get("boardId");
  if (!boardId) {
    return NextResponse.json({ error: "Missing boardId" }, { status: 400 });
  }

  // pin_fields asks Pinterest to include richer metadata on each pin — alt_text,
  // link (source URL), dominant_color. Falls back cleanly if the field isn't
  // returned for a given pin.
  const pinFields = "id,title,description,alt_text,link,media,dominant_color";
  const res = await fetch(
    `https://api.pinterest.com/v5/boards/${boardId}/pins?page_size=50&pin_fields=${pinFields}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
    .slice(0, 50)
    .map((pin: Record<string, unknown>) => {
      const media  = pin.media as Record<string, Record<string, { url: string }>>;
      const images = media.images ?? {};
      const imageUrl = (images["736x"] ?? images["1200x"] ?? images["400x300"] ?? images["orig"])?.url ?? "";
      const thumbUrl = (images["400x300"] ?? images["736x"] ?? images["150x150"])?.url ?? "";

      // Extract hostname from link if available (huge signal for style tribe)
      const link = typeof pin.link === "string" ? pin.link : undefined;
      let domain: string | undefined;
      if (link) {
        try { domain = new URL(link).hostname.replace(/^www\./, ""); } catch { /* malformed */ }
      }

      // Pinterest returns dominant_color as a single hex string on v5 for most
      // tiers; some tiers return an array. Normalize to array of hex strings.
      const dc = pin.dominant_color;
      const dominantColors: string[] = Array.isArray(dc)
        ? dc.filter((c): c is string => typeof c === "string")
        : typeof dc === "string" ? [dc] : [];

      return {
        id:             String(pin.id ?? ""),
        title:          String(pin.title ?? ""),
        description:    String(pin.description ?? ""),
        imageUrl,
        thumbUrl,
        altText:        typeof pin.alt_text === "string" ? pin.alt_text : undefined,
        link,
        domain,
        dominantColors: dominantColors.length > 0 ? dominantColors : undefined,
      };
    })
    .filter((p: PinData) => p.imageUrl);

  return NextResponse.json({ pins });
}
