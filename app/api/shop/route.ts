import { NextResponse } from "next/server";
import {
  analyzeAesthetic,
  fetchCandidateProductsByCategory,
  filterByAvoids,
  filterMensItems,
} from "@/lib/ai";
import { loadTasteMemory, saveStyleDNA } from "@/lib/taste-memory";
import type { VisionImage } from "@/lib/types";

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

    const aesthetic = await analyzeAesthetic(
      boardName,
      pinDescriptions,
      uploadedImages,
      tasteMemory.previousDNAs
    );

    const allAvoids = [
      ...(aesthetic.avoids ?? []),
      ...tasteMemory.softAvoids,
    ];

    const rawCandidates = await fetchCandidateProductsByCategory(aesthetic, token);

    const cats = ["dress", "top", "bottom", "jacket", "shoes", "bag"] as const;
    console.log("[shop] Algolia candidates:", Object.fromEntries(cats.map((c) => [c, rawCandidates[c].length])));

    const afterAvoids = filterByAvoids(rawCandidates, allAvoids);
    const candidates  = filterMensItems(afterAvoids);
    console.log("[shop] After avoid+gender filter:", Object.fromEntries(cats.map((c) => [c, candidates[c].length])));

    void saveStyleDNA(token, boardId, boardName, aesthetic)
      .catch((err) => console.warn("saveStyleDNA failed (non-fatal):", err));

    return NextResponse.json({ aesthetic, candidates });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shop] Failed:", message);
    return NextResponse.json({ error: "Shop analysis failed", detail: message }, { status: 500 });
  }
}
