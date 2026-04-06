import { NextResponse } from "next/server";
import { analyzeAesthetic, fetchCandidateProductsByCategory, curateProducts } from "@/lib/ai";
import { getServiceSupabase } from "@/lib/supabase";

export async function POST(request: Request) {
  const { boardId, boardName, pins } = await request.json();

  if (!boardId || !boardName) {
    return NextResponse.json({ error: "Missing boardId or boardName" }, { status: 400 });
  }

  const pinDescriptions: string[] = (pins ?? [])
    .map((p: { title?: string; description?: string }) =>
      [p.title, p.description].filter(Boolean).join(" — ")
    )
    .filter((d: string) => d.trim().length > 0);

  if (pinDescriptions.length === 0) {
    pinDescriptions.push(
      `This is a Pinterest board called "${boardName}". Infer a beautiful, specific aesthetic from the board name.`
    );
  }

  try {
    // Step 1: Claude builds a deep StyleDNA with category queries + style references
    const aesthetic = await analyzeAesthetic(boardName, pinDescriptions);

    // Step 2: Algolia fetches 5 candidates per category (30 total) — no more "6 dresses"
    const candidates = await fetchCandidateProductsByCategory(aesthetic);

    // Step 3: Claude curates 6 pieces into 2 outfits with how_to_wear + editorial layer
    const { products, editorial_intro, edit_rationale } = await curateProducts(aesthetic, candidates);

    // Step 4: Save to Supabase (best effort)
    try {
      const supabase = getServiceSupabase();
      const slug = `${boardName.toLowerCase().replace(/\s+/g, "-")}-${boardId}`;
      await supabase.from("storefronts").upsert(
        {
          board_id:        boardId,
          board_name:      boardName,
          slug,
          aesthetic_summary: JSON.stringify(aesthetic),
          products:          JSON.stringify(products),
          user_id:           "00000000-0000-0000-0000-000000000000",
        },
        { onConflict: "board_id" }
      );
    } catch (dbErr) {
      console.warn("Supabase save failed (non-fatal):", dbErr);
    }

    return NextResponse.json({ aesthetic, products, editorial_intro, edit_rationale });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Analysis failed:", message);
    return NextResponse.json({ error: "Analysis failed", detail: message }, { status: 500 });
  }
}
