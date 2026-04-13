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

interface ContextPayload {
  mode:            "pinterest" | "text" | "images" | "quiz";
  boardId?:        string;
  boardName?:      string;
  pins?:           Array<{ title?: string; description?: string }>;
  pinImageUrls?:   string[];
  textQuery?:      string;
  uploadedImages?: VisionImage[];
  answers?:        QuestionnaireAnswers;
}

export async function POST(request: Request) {
  const body = await request.json();
  const userToken: string = body.userToken ?? "";

  // Support both new multi-context format { contexts: [...] } and legacy single-mode format
  const contexts: ContextPayload[] = Array.isArray(body.contexts)
    ? body.contexts
    : [{ mode: body.mode ?? "pinterest", boardId: body.boardId, boardName: body.boardName,
         pins: body.pins, pinImageUrls: body.pinImageUrls, textQuery: body.textQuery,
         uploadedImages: body.uploadedImages, answers: body.answers }];

  if (contexts.length === 0) {
    return NextResponse.json({ error: "No contexts provided" }, { status: 400 });
  }

  // Merge all contexts into unified signals
  const allPinImageUrls:   string[]      = [];
  const allUploadedImages: VisionImage[] = [];
  const textParts:         string[]      = [];
  let   primaryBoardName                 = "your style";
  let   primaryBoardId:   string | undefined;
  const allPinDescriptions: string[]     = [];

  for (const ctx of contexts) {
    if (ctx.mode === "pinterest") {
      if (ctx.boardName) primaryBoardName = ctx.boardName;
      if (ctx.boardId)   primaryBoardId   = ctx.boardId;
      allPinImageUrls.push(...(ctx.pinImageUrls ?? []));
      allPinDescriptions.push(
        ...(ctx.pins ?? []).map((p) => [p.title, p.description].filter(Boolean).join(" — "))
      );
    } else if (ctx.mode === "text") {
      if (ctx.textQuery?.trim()) textParts.push(ctx.textQuery.trim());
    } else if (ctx.mode === "images") {
      allUploadedImages.push(...(ctx.uploadedImages ?? []));
    } else if (ctx.mode === "quiz" && ctx.answers) {
      // Convert quiz answers to text brief
      const q = ctx.answers;
      const brief = [
        q.occasions?.length  ? `Occasions: ${q.occasions.join(", ")}`  : "",
        q.vibes?.length      ? `Vibes: ${q.vibes.join(", ")}`          : "",
        q.colors?.length     ? `Colors: ${q.colors.join(", ")}`        : "",
        q.fits?.length       ? `Fit: ${q.fits.join(", ")}`             : "",
        q.priceRange         ? `Budget: ${q.priceRange}`               : "",
      ].filter(Boolean).join(". ");
      if (brief) textParts.push(brief);
    }
  }

  const extraTextContext = textParts.join("\n").trim() || undefined;

  // Determine primary mode for backward-compat paths
  const mode = contexts[0].mode;
  const boardName    = primaryBoardName;
  const boardId      = primaryBoardId;
  const pinImageUrls = allPinImageUrls;
  const uploadedImages = allUploadedImages;

  const token: string = userToken || "anon";

  try {
    const tasteMemory = await loadTasteMemory(token);

    // ── Aesthetic analysis ────────────────────────────────────────────────────
    let aesthetic: import("@/lib/types").StyleDNA;

    if (mode === "pinterest" || allPinImageUrls.length > 0 || allPinDescriptions.length > 0) {
      const pinDescriptions: string[] = allPinDescriptions.filter((d) => d.trim().length > 0);

      const pinImages: VisionImage[] = pinImageUrls.length
        ? await fetchPinImages(pinImageUrls)
        : [];

      if (pinDescriptions.length === 0 && pinImages.length === 0) {
        pinDescriptions.push(
          `This is a Pinterest board called "${boardName}". Infer a beautiful, specific aesthetic from the board name.`
        );
      }

      aesthetic = await analyzeAesthetic(
        boardName!,
        pinDescriptions,
        pinImages,
        tasteMemory.previousDNAs,
        extraTextContext
      );
    } else if (mode === "text") {
      aesthetic = await textQueryToAesthetic(
        (extraTextContext ?? contexts[0].textQuery ?? "").trim(),
        tasteMemory.previousDNAs
      );
    } else if (mode === "images") {
      // Use Claude vision on uploaded images to extract aesthetic
      aesthetic = await analyzeAesthetic(
        "uploaded images",
        [],
        uploadedImages.slice(0, 10),
        tasteMemory.previousDNAs,
        extraTextContext
      );
    } else {
      // quiz — extraTextContext already contains the quiz brief
      aesthetic = await textQueryToAesthetic(
        extraTextContext ?? "classic casual style",
        tasteMemory.previousDNAs
      );
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
