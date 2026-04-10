import { NextResponse } from "next/server";
import { curateProducts } from "@/lib/ai";
import { loadTasteMemory, saveImpressions } from "@/lib/taste-memory";
import { getRelevantTrends, formatTrendsBlock } from "@/lib/trends";
import type { StyleDNA } from "@/lib/types";
import type { CategoryCandidates } from "@/lib/algolia";

export async function POST(request: Request) {
  const { aesthetic, candidates, boardId, boardName, userToken } = await request.json();

  if (!aesthetic || !candidates) {
    return NextResponse.json({ error: "Missing aesthetic or candidates" }, { status: 400 });
  }

  const token: string = userToken || "anon";

  try {
    const [tasteMemory, relevantTrends] = await Promise.all([
      loadTasteMemory(token),
      getRelevantTrends(aesthetic as StyleDNA),
    ]);

    const trendsBlock = formatTrendsBlock(relevantTrends);

    const { products, editorial_intro, edit_rationale, outfit_arc, outfit_a_role, outfit_b_role } =
      await curateProducts(
        aesthetic as StyleDNA,
        candidates as CategoryCandidates,
        [],                           // no board images at curate stage
        tasteMemory.clickSignals,
        trendsBlock
      );

    console.log("[curate] Final products:", products.length,
      "outfit_a:", products.filter((p) => p.outfit_group === "outfit_a").length,
      "outfit_b:", products.filter((p) => p.outfit_group === "outfit_b").length
    );

    const sessionId = `${boardId ?? "board"}-${Date.now()}`;
    void saveImpressions(token, sessionId, products)
      .catch((err) => console.warn("saveImpressions failed (non-fatal):", err));

    return NextResponse.json({
      products,
      editorial_intro,
      edit_rationale,
      outfit_arc,
      outfit_a_role,
      outfit_b_role,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[curate] Failed:", message);
    return NextResponse.json({ error: "Curation failed", detail: message }, { status: 500 });
  }
}
