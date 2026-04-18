/**
 * GET /api/pinterest/fashion-boards
 *
 * Fetches all of the authenticated user's Pinterest boards, filters down
 * to the ones whose name or description suggests fashion/clothing content,
 * and samples up to 10 pin image URLs from each. Used by /shop to
 * automatically personalize the catalog feed when the user is signed in.
 *
 * Auth: pass the Pinterest access token via the Authorization: Bearer
 * header. No access token → 401.
 */

import { NextRequest, NextResponse } from "next/server";

// Keyword heuristic. Catches most genuine fashion boards without requiring
// Claude for classification. False positives are fine — a non-fashion pin
// image just won't match much in Pinecone downstream.
const FASHION_KEYWORDS = [
  "fashion", "style", "stylist", "styling", "inspo", "inspiration",
  "wardrobe", "closet", "outfit", "ootd", "look", "looks", "lookbook",
  "clothes", "clothing", "wear", "streetwear",
  "dress", "dresses", "skirt", "jean", "denim",
  "shoe", "shoes", "bag", "bags", "purse",
  "accessor", "jewel",
  "vintage", "thrift", "preloved", "archive",
  "fit", "fits", "capsule", "aesthetic",
];

function isFashionBoard(name: string, description?: string): boolean {
  const text = `${name} ${description ?? ""}`.toLowerCase();
  return FASHION_KEYWORDS.some((kw) => text.includes(kw));
}

interface BoardPin {
  id:       string;
  title:    string;
  imageUrl: string;
}

interface BoardWithPins {
  id:     string;
  name:   string;
  pins:   BoardPin[];
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const accessToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1. Fetch all boards (Pinterest returns up to 250 per page; one page covers
  //    virtually every user).
  let allBoards: Array<{ id: string; name: string; description?: string }> = [];
  try {
    const boardsRes = await fetch(
      "https://api.pinterest.com/v5/boards?page_size=250",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    if (!boardsRes.ok) {
      return NextResponse.json(
        { error: "Pinterest boards fetch failed", status: boardsRes.status },
        { status: boardsRes.status },
      );
    }
    const data = await boardsRes.json();
    allBoards = (data.items ?? []) as typeof allBoards;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Pinterest boards fetch threw", detail: message }, { status: 502 });
  }

  // 2. Filter fashion boards by keyword + cap to 8 for rate-limit hygiene.
  const fashionBoards = allBoards.filter((b) => isFashionBoard(b.name ?? "", b.description)).slice(0, 8);
  if (fashionBoards.length === 0) {
    return NextResponse.json({
      totalBoards:   allBoards.length,
      fashionBoards: 0,
      boards:        [] as BoardWithPins[],
      pinImageUrls:  [] as string[],
    });
  }

  // 3. Fetch pins from each fashion board in parallel, 10 pins per board.
  const results: BoardWithPins[] = await Promise.all(
    fashionBoards.map(async (b): Promise<BoardWithPins> => {
      try {
        const pinsRes = await fetch(
          `https://api.pinterest.com/v5/boards/${b.id}/pins?page_size=10&pin_fields=id,title,media`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          },
        );
        if (!pinsRes.ok) return { id: b.id, name: b.name, pins: [] };
        const pinsData = await pinsRes.json();
        const pins: BoardPin[] = ((pinsData.items ?? []) as Array<Record<string, unknown>>)
          .filter((p) => {
            const media = p.media as Record<string, unknown> | undefined;
            return media?.media_type === "image" && !!media?.images;
          })
          .map((p) => {
            const media  = p.media as Record<string, Record<string, { url: string }>>;
            const images = media.images ?? {};
            const imageUrl =
              (images["736x"] ?? images["1200x"] ?? images["400x300"] ?? images["orig"])?.url ?? "";
            return {
              id:       String(p.id ?? ""),
              title:    String(p.title ?? ""),
              imageUrl,
            };
          })
          .filter((p) => p.imageUrl);
        return { id: b.id, name: b.name, pins };
      } catch {
        return { id: b.id, name: b.name, pins: [] };
      }
    }),
  );

  const pinImageUrls = results.flatMap((b) => b.pins.map((p) => p.imageUrl));

  return NextResponse.json({
    totalBoards:   allBoards.length,
    fashionBoards: fashionBoards.length,
    boards:        results,
    pinImageUrls,
  });
}
