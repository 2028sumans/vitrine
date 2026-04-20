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
  searchByEmbeddings,
  blendCentroids,
  clusterEmbeddings,
  embedImageUrls,
  embedBase64Images,
  embedTextQuery,
  warmupEmbeddingModels,
}                                               from "@/lib/embeddings";
import { hybridSearch }                         from "@/lib/hybrid-search";
import {
  buildTextQueryVectors,
  anchorImageVectorsWithAesthetic,
}                                               from "@/lib/query-builder";
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

interface PinPayload {
  title?:          string;
  description?:    string;
  altText?:        string;
  link?:           string;
  domain?:         string;
  dominantColors?: string[];
}

interface ContextPayload {
  mode:            "pinterest" | "text" | "images" | "quiz";
  boardId?:        string;
  boardName?:      string;
  pins?:           PinPayload[];
  pinImageUrls?:   string[];
  textQuery?:      string;
  uploadedImages?: VisionImage[];
  answers?:        QuestionnaireAnswers;
}

export async function POST(request: Request) {
  // Kick off the FashionCLIP model download immediately — it runs in the
  // background while Claude Haiku extracts the aesthetic. On a cold Lambda
  // the model fetch is 10–30 s and would otherwise serialise with the
  // downstream embed calls; overlapping with Claude cuts that out.
  warmupEmbeddingModels();

  const body = await request.json();
  const userToken: string = body.userToken ?? "";
  // Opt-in switch for the learned taste projection head. Accept truthy forms
  // so it's easy to pass from either server code (`taste: true`) or a raw
  // client URL param rewrite (`taste: "1"`).
  const useTasteHead: boolean = body.taste === true || body.taste === 1 || body.taste === "1";

  // User-selected price tier from the intake form. When present and not
  // "all", we override aesthetic.price_range after Claude returns — this
  // way every downstream step (Pinecone filter, Algolia priceFilter,
  // curation) respects the user's choice as a hard constraint rather than
  // a soft inference from the board.
  //
  // The intake offers 4 buckets ("under100" | "100to300" | "300to1000" |
  // "over1000"); our internal pipeline only knows budget/mid/luxury, so
  // sub-$100 → budget, $100–300 → mid, everything above → luxury.
  // The mapping collapses a bit of precision but keeps the retrieval
  // pipeline unchanged and ensures Claude's aesthetic synthesis runs
  // inside the chosen envelope.
  const rawTier = typeof body.priceTier === "string" ? body.priceTier : "all";
  const priceOverride: "budget" | "mid" | "luxury" | null =
    rawTier === "under100"   ? "budget" :
    rawTier === "100to300"   ? "mid"    :
    rawTier === "300to1000"  ? "luxury" :
    rawTier === "over1000"   ? "luxury" :
    null;

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
  // Richer pin metadata accumulators — fed to Claude for two-pass analysis
  const allPinMeta: PinPayload[] = [];
  const allDomains: string[]     = [];

  for (const ctx of contexts) {
    if (ctx.mode === "pinterest") {
      if (ctx.boardName) primaryBoardName = ctx.boardName;
      if (ctx.boardId)   primaryBoardId   = ctx.boardId;
      allPinImageUrls.push(...(ctx.pinImageUrls ?? []));
      allPinDescriptions.push(
        ...(ctx.pins ?? []).map((p) => [p.title, p.description, p.altText].filter(Boolean).join(" — "))
      );
      for (const p of ctx.pins ?? []) {
        allPinMeta.push(p);
        if (p.domain) allDomains.push(p.domain);
      }
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

      // Top 5 unique source domains — huge signal for price tier and style tribe
      const uniqueDomains = Array.from(new Set(allDomains)).slice(0, 5);
      aesthetic = await analyzeAesthetic(
        boardName!,
        pinDescriptions,
        pinImages,
        tasteMemory.previousDNAs,
        extraTextContext,
        allPinMeta.slice(0, 12),          // per-pin metadata (aligned with pinImages order)
        { sourceDomains: uniqueDomains }, // board-level signal
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

    // User-selected price tier is a HARD override on Claude's inferred
    // price_range. It precedes candidate fetch, so every downstream filter
    // (Pinecone numeric price_range filter, Algolia priceFilter, curation
    // scoring) sees the user's chosen envelope. "all" (priceOverride === null)
    // leaves Claude's inference intact.
    if (priceOverride) {
      console.log(`[shop] priceTier override: ${aesthetic.price_range} → ${priceOverride}`);
      aesthetic = { ...aesthetic, price_range: priceOverride };
    }

    const allAvoids = [...(aesthetic.avoids ?? []), ...tasteMemory.softAvoids];

    // ── Product retrieval ─────────────────────────────────────────────────────
    let rawCandidates: import("@/lib/algolia").CategoryCandidates;

    if (USE_VISUAL_SEARCH && mode === "images" && uploadedImages?.length) {
      // Image upload → FashionCLIP embed → aesthetic-anchor blend → hybrid search.
      console.log("[shop] Hybrid search: uploaded images (with aesthetic anchor)");
      const rawEmb = await embedBase64Images(uploadedImages.slice(0, 10));
      const anchored = await anchorImageVectorsWithAesthetic(rawEmb, aesthetic, tasteMemory.softAvoids);
      rawCandidates  = await hybridSearch(anchored, aesthetic, token, 20, { useTasteHead });

    } else if (USE_VISUAL_SEARCH && mode === "pinterest" && pinImageUrls?.length) {
      // Pinterest → FashionCLIP embed → cross-session centroid + 10% aesthetic
      // anchor + negative subtraction → hybrid Pinecone + Algolia
      console.log("[shop] Hybrid search: Pinterest board images (with aesthetic anchor)");

      let embeddings = await embedImageUrls(pinImageUrls.slice(0, 20));
      const validEmbeddings = embeddings.filter((e) => e.length > 0);

      // Existing nudge toward cross-session style centroid (kept as-is)
      if (tasteMemory.styleCentroid && validEmbeddings.length > 0) {
        console.log("[shop] Blending cross-session style centroid");
        embeddings = validEmbeddings.map((emb) =>
          blendCentroids(emb, [tasteMemory.styleCentroid!], 0.15)
        );
      }

      // NEW: blend the inferred aesthetic in at 10% weight + subtract avoids.
      // Anchors visually-noisy boards to their semantic intent.
      embeddings = await anchorImageVectorsWithAesthetic(
        embeddings,
        aesthetic,
        tasteMemory.softAvoids,
      );

      rawCandidates = await hybridSearch(embeddings, aesthetic, token, 20, { useTasteHead });

    } else if (USE_VISUAL_SEARCH && (mode === "text" || mode === "quiz")) {
      // Text/quiz → multi-vector ensemble query (per-category phrasing) +
      // negative subtraction of avoids → hybrid Pinecone + Algolia.
      console.log("[shop] Hybrid search: multi-vector text ensemble via FashionCLIP");
      const queryVectors = await buildTextQueryVectors(aesthetic, tasteMemory.softAvoids);
      console.log(`[shop] Built ${queryVectors.length} query vectors (positives - negatives)`);
      rawCandidates      = await hybridSearch(queryVectors, aesthetic, token, 20, { useTasteHead });

    } else {
      // No Pinecone → pure Algolia text search
      console.log(`[shop] Algolia text search (mode=${mode}, Pinecone=${USE_VISUAL_SEARCH})`);
      rawCandidates = await fetchCandidateProductsByCategory(aesthetic, token);
    }

    // ── Filters ───────────────────────────────────────────────────────────────
    // Vision re-rank was previously invoked here but it added 3-8s of latency
    // on initial load for limited perceived quality lift (the subsequent
    // /api/curate Claude call already evaluates images and composes outfits).
    // Removed for speed. Function remains in lib/ai.ts for future use.
    const afterAvoids = filterByAvoids(rawCandidates, allAvoids);
    const candidates  = filterMensItems(afterAvoids);

    // ── Persist StyleDNA (fire and forget, Pinterest boards only) ─────────────
    if (mode === "pinterest" && boardId && boardName) {
      void saveStyleDNA(token, boardId, boardName, aesthetic)
        .catch((err) => console.warn("saveStyleDNA failed (non-fatal):", err));
    }

    return NextResponse.json({ aesthetic, candidates, clickSignals: tasteMemory.clickSignals });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shop] Failed:", message);
    return NextResponse.json({ error: "Shop analysis failed", detail: message }, { status: 500 });
  }
}
