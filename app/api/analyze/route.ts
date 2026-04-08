import { NextResponse } from "next/server";
import {
  analyzeAesthetic,
  fetchCandidateProductsByCategory,
  filterByAvoids,
  curateProducts,
} from "@/lib/ai";
import { getServiceSupabase } from "@/lib/supabase";
import {
  loadTasteMemory,
  saveStyleDNA,
  saveImpressions,
} from "@/lib/taste-memory";
import { getRelevantTrends, formatTrendsBlock } from "@/lib/trends";
import type { VisionImage } from "@/lib/types";

// Fetch Pinterest CDN images server-side and convert to base64 for Claude
async function fetchPinImages(urls: string[]): Promise<VisionImage[]> {
  const results = await Promise.allSettled(
    urls.slice(0, 12).map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buffer    = await res.arrayBuffer();
      const base64    = Buffer.from(buffer).toString("base64");
      const mimeType  = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];
      return { base64, mimeType } as VisionImage;
    })
  );
  return results
    .filter((r): r is PromiseFulfilledResult<VisionImage> => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);
}

export async function POST(request: Request) {
  const { boardId, boardName, pins, images, pinImageUrls, userToken } = await request.json();

  if (!boardId || !boardName) {
    return NextResponse.json({ error: "Missing boardId or boardName" }, { status: 400 });
  }

  const pinDescriptions: string[] = (pins ?? [])
    .map((p: { title?: string; description?: string }) =>
      [p.title, p.description].filter(Boolean).join(" — ")
    )
    .filter((d: string) => d.trim().length > 0);

  // Pin images take priority; fall back to manually uploaded images
  const uploadedImages: VisionImage[] = pinImageUrls?.length
    ? await fetchPinImages(pinImageUrls)
    : (images ?? []).slice(0, 12);

  if (pinDescriptions.length === 0 && uploadedImages.length === 0) {
    pinDescriptions.push(
      `This is a Pinterest board called "${boardName}". Infer a beautiful, specific aesthetic from the board name.`
    );
  }

  const token: string = userToken || "anon";

  try {
    // Load taste memory and trends in parallel — both are non-blocking on analysis
    const [tasteMemory] = await Promise.all([
      loadTasteMemory(token),
    ]);

    // Step 1: Analyze aesthetic — synthesises board images + taste history
    const aesthetic = await analyzeAesthetic(
      boardName,
      pinDescriptions,
      uploadedImages,
      tasteMemory.previousDNAs   // living StyleDNA context
    );

    // Merge explicit avoids (from Claude) + behavioral soft avoids (from impression history)
    const allAvoids = [
      ...(aesthetic.avoids ?? []),
      ...tasteMemory.softAvoids,
    ];

    // Step 2: Algolia + Pinterest Trends — run in parallel
    const [rawCandidates, relevantTrends] = await Promise.all([
      fetchCandidateProductsByCategory(aesthetic, token),
      getRelevantTrends(aesthetic),
    ]);

    // Step 2b: Hard-filter avoids before Claude ever sees them
    const candidates = filterByAvoids(rawCandidates, allAvoids);

    // Format trends into a Claude-readable block
    const trendsBlock = formatTrendsBlock(relevantTrends);

    // Step 3: Two-stage curation
    //   3a — visual shortlist: board images tell Claude what to eliminate (48 → 12)
    //   3b — outfit build: product images + click history + narrative arc + trends
    const { products, editorial_intro, edit_rationale, outfit_arc, outfit_a_role, outfit_b_role } =
      await curateProducts(
        aesthetic,
        candidates,
        uploadedImages,            // board images for visual grounding in Stage 1
        tasteMemory.clickSignals,  // confirmed taste signals for Stage 2
        trendsBlock                // Pinterest trending signals for commentary
      );

    // Persist results (best-effort, fire-and-forget — never block the response)
    const sessionId = `${boardId}-${Date.now()}`;
    void Promise.all([
      // Save this StyleDNA to history
      saveStyleDNA(token, boardId, boardName, aesthetic),
      // Save product impressions for implicit negative tracking
      saveImpressions(token, sessionId, products),
      // Save to storefronts table
      (async () => {
        try {
          const supabase = getServiceSupabase();
          const slug = `${boardName.toLowerCase().replace(/\s+/g, "-")}-${boardId}`;
          await supabase.from("storefronts").upsert(
            {
              board_id:          boardId,
              board_name:        boardName,
              slug,
              aesthetic_summary: JSON.stringify(aesthetic),
              products:          JSON.stringify(products),
              user_id:           "00000000-0000-0000-0000-000000000000",
            },
            { onConflict: "board_id" }
          );
        } catch (dbErr) {
          console.warn("Supabase storefronts save failed (non-fatal):", dbErr);
        }
      })(),
    ]).catch((err) => console.warn("Background persistence failed (non-fatal):", err));

    return NextResponse.json({
      aesthetic,
      products,
      editorial_intro,
      edit_rationale,
      outfit_arc,
      outfit_a_role,
      outfit_b_role,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Analysis failed:", message);
    return NextResponse.json({ error: "Analysis failed", detail: message }, { status: 500 });
  }
}
