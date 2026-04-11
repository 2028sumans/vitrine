import { NextResponse }                         from "next/server";
import {
  analyzeAesthetic,
  fetchCandidateProductsByCategory,
  filterByAvoids,
  filterMensItems,
  textQueryToAesthetic,
  questionnaireToAesthetic,
}                                               from "@/lib/ai";
import { getProductsByIds, groupByCategory }    from "@/lib/algolia";
import {
  searchByBoardImages,
  searchByUploadedImages,
  searchByEmbeddings,
  blendCentroids,
  clusterEmbeddings,
  embedImageUrls,
}                                               from "@/lib/embeddings";
import { loadTasteMemory, saveStyleDNA }        from "@/lib/taste-memory";
import type { VisionImage, QuestionnaireAnswers } from "@/lib/types";

// Use visual search if Pinecone is configured; fall back to Algolia text search
const USE_VISUAL_SEARCH = !!(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX);

async function fetchPinImages(urls: string[]): Promise<VisionImage[]> {
  // Claude multi-image requests cap each dimension at 2000px.
  // Pinterest CDN supports size variants in the path — rewrite to 474x
  // (max ~474px wide) which is well under the limit.
  const safeUrls = urls.slice(0, 12).map((url) =>
    url.includes("pinimg.com")
      ? url.replace(/\/(?:originals|[0-9]+x)\//, "/736x/")
      : url
  );

  const results = await Promise.allSettled(
    safeUrls.map(async (url) => {
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
  const {
    // Mode selector
    mode = "pinterest",
    // Pinterest mode
    boardId, boardName, pins, pinImageUrls,
    // Text mode
    textQuery,
    // Images mode
    uploadedImages,
    // Quiz mode
    answers,
    // Common
    userToken,
  }: {
    mode?:           "pinterest" | "text" | "images" | "quiz";
    boardId?:        string;
    boardName?:      string;
    pins?:           Array<{ title?: string; description?: string }>;
    pinImageUrls?:   string[];
    textQuery?:      string;
    uploadedImages?: VisionImage[];
    answers?:        QuestionnaireAnswers;
    userToken?:      string;
  } = await request.json();

  // Validate required fields per mode
  if (mode === "pinterest" && (!boardId || !boardName)) {
    return NextResponse.json({ error: "Missing boardId or boardName" }, { status: 400 });
  }
  if (mode === "text" && !textQuery?.trim()) {
    return NextResponse.json({ error: "Missing textQuery" }, { status: 400 });
  }
  if (mode === "images" && !uploadedImages?.length) {
    return NextResponse.json({ error: "Missing uploadedImages" }, { status: 400 });
  }
  if (mode === "quiz" && !answers) {
    return NextResponse.json({ error: "Missing answers" }, { status: 400 });
  }

  const token: string = userToken || "anon";

  try {
    const tasteMemory = await loadTasteMemory(token);

    // ── Aesthetic analysis ────────────────────────────────────────────────────
    let aesthetic: import("@/lib/types").StyleDNA;

    if (mode === "pinterest") {
      const pinDescriptions: string[] = (pins ?? [])
        .map((p) => [p.title, p.description].filter(Boolean).join(" — "))
        .filter((d) => d.trim().length > 0);

      const uploadedImages: VisionImage[] = pinImageUrls?.length
        ? await fetchPinImages(pinImageUrls)
        : [];

      if (pinDescriptions.length === 0 && uploadedImages.length === 0) {
        pinDescriptions.push(
          `This is a Pinterest board called "${boardName}". Infer a beautiful, specific aesthetic from the board name.`
        );
      }

      aesthetic = await analyzeAesthetic(
        boardName!,
        pinDescriptions,
        uploadedImages,
        tasteMemory.previousDNAs
      );
    } else if (mode === "text") {
      aesthetic = await textQueryToAesthetic(textQuery!.trim(), tasteMemory.previousDNAs);
    } else if (mode === "images") {
      // Use Claude vision on uploaded images to extract aesthetic
      aesthetic = await analyzeAesthetic(
        "uploaded images",
        [],
        (uploadedImages ?? []).slice(0, 10),
        tasteMemory.previousDNAs
      );
    } else {
      // quiz
      aesthetic = await questionnaireToAesthetic(answers!, tasteMemory.previousDNAs);
    }

    const allAvoids = [...(aesthetic.avoids ?? []), ...tasteMemory.softAvoids];

    // ── Product retrieval ─────────────────────────────────────────────────────
    let rawCandidates: import("@/lib/algolia").CategoryCandidates;

    if (USE_VISUAL_SEARCH && mode === "images" && uploadedImages?.length) {
      // Image upload → CLIP embed → Pinecone visual search
      console.log("[shop] Visual search: uploaded images");
      const objectIDs = await searchByUploadedImages(
        uploadedImages.slice(0, 10),
        120,
        aesthetic.price_range
      );
      console.log(`[shop] Pinecone returned ${objectIDs.length} objectIDs`);
      const products = await getProductsByIds(objectIDs);
      rawCandidates  = groupByCategory(products, 20);

    } else if (USE_VISUAL_SEARCH && mode === "pinterest" && pinImageUrls?.length) {
      // Pinterest → CLIP embed → Pinecone visual search (existing path)
      console.log("[shop] Visual search: Pinterest board images");

      let objectIDs = await searchByBoardImages(
        pinImageUrls.slice(0, 20),
        120,
        aesthetic.price_range
      );

      // If user has a cross-session style centroid, nudge results toward it
      if (tasteMemory.styleCentroid && objectIDs.length > 0) {
        console.log("[shop] Blending cross-session style centroid");
        const { embedImageUrls: embed } = await import("@/lib/embeddings");
        const pinEmbeddings = await embed(pinImageUrls.slice(0, 20));
        const validEmbeddings = pinEmbeddings.filter((e) => e.length > 0);
        if (validEmbeddings.length > 0) {
          const nudgedEmbeddings = validEmbeddings.map((emb) =>
            blendCentroids(emb, [tasteMemory.styleCentroid!], 0.15)
          );
          objectIDs = await searchByEmbeddings(nudgedEmbeddings, 120, aesthetic.price_range);
        }
      }

      console.log(`[shop] Pinecone returned ${objectIDs.length} objectIDs`);
      const products = await getProductsByIds(objectIDs);
      rawCandidates  = groupByCategory(products, 20);

    } else {
      // Text / quiz / no-Pinecone fallback → Algolia text search
      console.log(`[shop] Algolia text search (mode=${mode}, Pinecone=${USE_VISUAL_SEARCH})`);
      rawCandidates = await fetchCandidateProductsByCategory(aesthetic, token);
    }

    // ── Filters ───────────────────────────────────────────────────────────────
    const afterAvoids = filterByAvoids(rawCandidates, allAvoids);
    const candidates  = filterMensItems(afterAvoids);

    // ── Persist StyleDNA (fire and forget, Pinterest boards only) ─────────────
    if (mode === "pinterest" && boardId && boardName) {
      void saveStyleDNA(token, boardId, boardName, aesthetic)
        .catch((err) => console.warn("saveStyleDNA failed (non-fatal):", err));
    }

    return NextResponse.json({ aesthetic, candidates });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shop] Failed:", message);
    return NextResponse.json({ error: "Shop analysis failed", detail: message }, { status: 500 });
  }
}
