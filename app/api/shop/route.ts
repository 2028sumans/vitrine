import { NextResponse }                         from "next/server";
import {
  analyzeAesthetic,
  fetchCandidateProductsByCategory,
  filterByAvoids,
  filterMensItems,
}                                               from "@/lib/ai";
import { getProductsByIds, groupByCategory }    from "@/lib/algolia";
import { searchByBoardImages }                  from "@/lib/embeddings";
import { loadTasteMemory, saveStyleDNA }        from "@/lib/taste-memory";
import type { VisionImage }                     from "@/lib/types";

// Use visual search if Pinecone is configured; fall back to Algolia text search
const USE_VISUAL_SEARCH = !!(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX);

async function fetchPinImages(urls: string[]): Promise<VisionImage[]> {
  const results = await Promise.allSettled(
    urls.slice(0, 20).map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buffer   = await res.arrayBuffer();
      const base64   = Buffer.from(buffer).toString("base64");
      const mimeType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];
      return { base64, mimeType } as VisionImage;
    })
  );
  return results
    .filter((r): r is PromiseFulfilledResult<VisionImage> => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);
}

export async function POST(request: Request) {
  const { boardId, boardName, pins, pinImageUrls, userToken } = await request.json();

  if (!boardId || !boardName) {
    return NextResponse.json({ error: "Missing boardId or boardName" }, { status: 400 });
  }

  const pinDescriptions: string[] = (pins ?? [])
    .map((p: { title?: string; description?: string }) =>
      [p.title, p.description].filter(Boolean).join(" — ")
    )
    .filter((d: string) => d.trim().length > 0);

  const uploadedImages: VisionImage[] = pinImageUrls?.length
    ? await fetchPinImages(pinImageUrls)
    : [];

  if (pinDescriptions.length === 0 && uploadedImages.length === 0) {
    pinDescriptions.push(
      `This is a Pinterest board called "${boardName}". Infer a beautiful, specific aesthetic from the board name.`
    );
  }

  const token: string = userToken || "anon";

  try {
    const tasteMemory = await loadTasteMemory(token);

    // ── Aesthetic analysis (always runs — needed for StyleDNA + Claude prompt) ─
    const aesthetic = await analyzeAesthetic(
      boardName,
      pinDescriptions,
      uploadedImages,
      tasteMemory.previousDNAs
    );

    const allAvoids = [...(aesthetic.avoids ?? []), ...tasteMemory.softAvoids];

    // ── Product retrieval: visual search OR text search ────────────────────────
    let rawCandidates: import("@/lib/algolia").CategoryCandidates;

    if (USE_VISUAL_SEARCH && (pinImageUrls ?? []).length > 0) {
      console.log("[shop] Using visual embedding search via Pinecone…");

      // Embed board images → cluster by repetition → weighted Pinecone queries
      const objectIDs = await searchByBoardImages(
        pinImageUrls.slice(0, 20),
        120,                     // retrieve 120 visually nearest products
        aesthetic.price_range
      );

      console.log(`[shop] Pinecone returned ${objectIDs.length} objectIDs`);

      // Fetch full product records from Algolia (preserves ranking order)
      const products  = await getProductsByIds(objectIDs);
      rawCandidates   = groupByCategory(products, 20);

      console.log("[shop] Visual candidates by category:",
        Object.fromEntries(
          (["dress","top","bottom","jacket","shoes","bag"] as const).map((c) => [c, rawCandidates[c].length])
        )
      );
    } else {
      // Fallback: classic Algolia text search (runs before Pinecone is set up,
      // or when no board images are available)
      console.log("[shop] Using Algolia text search (Pinecone not configured or no board images).");
      rawCandidates = await fetchCandidateProductsByCategory(aesthetic, token);
    }

    // ── Filters (same regardless of retrieval method) ─────────────────────────
    const afterAvoids  = filterByAvoids(rawCandidates, allAvoids);
    const candidates   = filterMensItems(afterAvoids);

    const cats = ["dress", "top", "bottom", "jacket", "shoes", "bag"] as const;
    console.log("[shop] Final candidates:", Object.fromEntries(cats.map((c) => [c, candidates[c].length])));

    void saveStyleDNA(token, boardId, boardName, aesthetic)
      .catch((err) => console.warn("saveStyleDNA failed (non-fatal):", err));

    return NextResponse.json({ aesthetic, candidates });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shop] Failed:", message);
    return NextResponse.json({ error: "Shop analysis failed", detail: message }, { status: 500 });
  }
}
