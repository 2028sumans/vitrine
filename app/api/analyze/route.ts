import { NextResponse } from "next/server";
import { analyzeAesthetic, recommendProducts } from "@/lib/ai";
import { getServiceSupabase } from "@/lib/supabase";

export async function POST(request: Request) {
  const { boardId, boardName, pins } = await request.json();

  if (!boardId || !boardName) {
    return NextResponse.json({ error: "Missing boardId or boardName" }, { status: 400 });
  }

  // Build pin descriptions for the AI
  const pinDescriptions: string[] = (pins ?? [])
    .map((p: { title?: string; description?: string }) =>
      [p.title, p.description].filter(Boolean).join(" — ")
    )
    .filter((d: string) => d.trim().length > 0);

  // If no real pins provided, use board name as context (mock mode)
  if (pinDescriptions.length === 0) {
    pinDescriptions.push(
      `This is a Pinterest board called "${boardName}". Infer a beautiful, specific aesthetic from the board name.`
    );
  }

  try {
    // Step 1: Analyze aesthetic
    const aesthetic = await analyzeAesthetic(boardName, pinDescriptions);

    // Step 2: Get product recommendations
    const products = await recommendProducts(boardName, aesthetic);

    // Step 3: Save to Supabase (best effort — don't fail if DB unavailable)
    try {
      const supabase = getServiceSupabase();
      const slug = `${boardName.toLowerCase().replace(/\s+/g, "-")}-${boardId}`;
      await supabase.from("storefronts").upsert(
        {
          board_id: boardId,
          board_name: boardName,
          slug,
          aesthetic_summary: JSON.stringify(aesthetic),
          products: JSON.stringify(products),
          user_id: "00000000-0000-0000-0000-000000000000", // placeholder until auth is wired
        },
        { onConflict: "board_id" }
      );
    } catch (dbErr) {
      console.warn("Supabase save failed (non-fatal):", dbErr);
    }

    return NextResponse.json({ aesthetic, products });
  } catch (err) {
    console.error("Analysis failed:", err);
    return NextResponse.json({ error: "Analysis failed" }, { status: 500 });
  }
}
