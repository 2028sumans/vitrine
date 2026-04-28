import { NextResponse }                         from "next/server";
import {
  analyzeAesthetic,
  applyFocusSkew,
  fetchCandidateProductsByCategory,
  filterByAvoids,
  filterMensItems,
  textQueryToAesthetic,
}                                               from "@/lib/ai";
import { getProductsByIds, groupByCategory }    from "@/lib/algolia";
import {
  searchByEmbeddings,
  blendCentroids,
  clusterEmbeddings,
  embedImageUrls,
  embedBase64Images,
  warmupEmbeddingModels,
}                                               from "@/lib/embeddings";
import { hybridSearch, twoStageStrictSearch }   from "@/lib/hybrid-search";
import {
  buildTextQueryVectors,
  anchorImageVectorsWithAesthetic,
}                                               from "@/lib/query-builder";
import { loadTasteMemory, saveStyleDNA, getStyleDNAByBoard } from "@/lib/taste-memory";
import type { VisionImage } from "@/lib/types";

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
  mode:            "pinterest" | "text" | "images";
  boardId?:        string;
  boardName?:      string;
  pins?:           PinPayload[];
  pinImageUrls?:   string[];
  textQuery?:      string;
  uploadedImages?: VisionImage[];
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
  // Debug mode — pass `?debug=1` (or body.debug=true) to get per-item
  // ranking breakdown attached to every product. Use sparingly: increases
  // response size ~30% and isn't user-facing. Engineering surface only.
  const url   = new URL(request.url);
  const debug = body.debug === true || body.debug === 1 || body.debug === "1"
             || url.searchParams.get("debug") === "1";

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

  // Optional category scope. When the search runs from a /shop category page
  // (Tops, Dresses, etc.), the caller passes the display label here. We map
  // it to the catalog's ClothingCategory key and force focus_categories on
  // the StyleDNA so all downstream retrieval (Pinecone, Algolia) returns
  // only that category, regardless of what Claude inferred from the brief.
  // This makes the dashboard intake usable as an in-page search bar on each
  // category page without leaking off-category results.
  //
  // "Knits" maps to {top, jacket} — there's no knit category in the catalog,
  // so we widen to the two categories where knit garments live and rely on
  // Claude's keywords to surface knits within those buckets. "Shop all"
  // (or undefined / "all") bypasses scoping entirely.
  const rawCategory: string = typeof body.categoryFilter === "string"
    ? body.categoryFilter.trim()
    : "";
  type ClothingCategoryKey = "top" | "dress" | "bottom" | "jacket" | "shoes" | "bag";
  function mapCategoryFilter(label: string): ClothingCategoryKey[] {
    switch (label.toLowerCase()) {
      case "tops":                 return ["top"];
      case "dresses":              return ["dress"];
      case "bottoms":              return ["bottom"];
      case "outerwear":            return ["jacket"];
      case "shoes":                return ["shoes"];
      case "bags and accessories": return ["bag"];
      case "knits":                return ["top", "jacket"];
      default:                     return [];        // "shop all" / unknown
    }
  }
  const forcedFocusCategories = mapCategoryFilter(rawCategory);

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

  // ── Streaming response ────────────────────────────────────────────────────
  // The pipeline is "aesthetic analysis (2–4 s)" then "candidate fetch
  // (1–3 s)". Historically we awaited both before returning one JSON blob,
  // so the user stared at "Musing…" for the full 5–7 s with no progress.
  // Now we stream NDJSON events as each phase completes, letting the client
  // advance its progress dots in real time and start rendering the aesthetic
  // before candidates finish.
  //
  // Event shape (one JSON object per line):
  //   { phase: "aesthetic",  aesthetic, cached }            — first event
  //   { phase: "candidates", candidates, clickSignals }     — second event
  //   { phase: "done" }                                     — terminal
  //   { phase: "error",     detail }                        — on failure
  //
  // Only /app/dashboard consumes this endpoint; callers parse line-by-line.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        const tasteMemory = await loadTasteMemory(token);

        // ── Aesthetic analysis (with board-cache short-circuit) ─────────────
        let aesthetic: import("@/lib/types").StyleDNA;
        let aestheticCached = false;

        // Fast path: same user re-analyzing the same Pinterest board within
        // the 24h TTL. Skips Sonnet vision + Haiku synthesis entirely,
        // collapsing 2–4 s of critical-path latency into a ~50 ms Supabase
        // read.
        if (mode === "pinterest" && token !== "anon" && boardId) {
          try {
            const cached = await getStyleDNAByBoard(token, boardId);
            if (cached) {
              aesthetic = cached.dna;
              aestheticCached = true;
              console.log(`[shop] StyleDNA cache HIT (board=${boardId})`);
            }
          } catch (e) {
            console.warn("[shop] StyleDNA cache lookup failed (non-fatal):", e instanceof Error ? e.message : e);
          }
        }

        // Pinterest/images mode: we need the base64 images both for Claude
        // vision AND for FashionCLIP embedding. Fetch once, share both ways.
        // The embedding work runs in parallel with the Claude vision call
        // (see below) so two ~5 s operations overlap into ~5 s instead of 10.
        let sharedPinImages: VisionImage[] = [];

        // Fire FashionCLIP embedding in parallel with the Claude vision call.
        // We await it later after the aesthetic has been emitted, so the
        // user sees progress as soon as Claude returns.
        let pinEmbeddingsPromise: Promise<number[][]> | null = null;

        if (!aestheticCached) {
          if (mode === "pinterest" || allPinImageUrls.length > 0 || allPinDescriptions.length > 0) {
            const pinDescriptions: string[] = allPinDescriptions.filter((d) => d.trim().length > 0);

            sharedPinImages = pinImageUrls.length
              ? await fetchPinImages(pinImageUrls)
              : [];

            if (pinDescriptions.length === 0 && sharedPinImages.length === 0) {
              pinDescriptions.push(
                `This is a Pinterest board called "${boardName}". Infer a beautiful, specific aesthetic from the board name.`
              );
            }

            // Start FashionCLIP embedding in parallel with Claude vision
            // instead of waiting for Claude to finish first. Saves ~5–12 s
            // on a warm lambda; more on cold. The images are already in
            // base64 so no re-download.
            if (USE_VISUAL_SEARCH && sharedPinImages.length > 0) {
              pinEmbeddingsPromise = embedBase64Images(sharedPinImages.slice(0, 10))
                .catch((err) => {
                  console.warn("[shop] parallel embed failed (non-fatal):", err);
                  return [] as number[][];
                });
            }

            // Top 5 unique source domains — huge signal for price tier and style tribe
            const uniqueDomains = Array.from(new Set(allDomains)).slice(0, 5);
            aesthetic = await analyzeAesthetic(
              boardName!,
              pinDescriptions,
              sharedPinImages,
              tasteMemory.previousDNAs,
              extraTextContext,
              allPinMeta.slice(0, 12),
              { sourceDomains: uniqueDomains },
            );
          } else if (mode === "text") {
            // For text mode, use ONLY the user's typed query — not the
            // merged `extraTextContext`, which appends onboarding-quiz
            // answers, shortlist hints, and other context blocks. Those
            // injections are appropriate when the user gave us images
            // and we need extra signal, but for a deliberate typed
            // query they actively pollute the brief: a user with
            // feminine onboarding vibes typing "dad chic" had Claude
            // reading "dad chic\nUser's stated preferences: vibes=
            // [feminine, romantic, ...]" and predictably produced
            // feminine results. The H3 short-pivot guard in
            // textQueryToAesthetic also misfires on the bloated text.
            const userQuery = (contexts[0].textQuery ?? "").trim();
            aesthetic = await textQueryToAesthetic(
              userQuery,
              tasteMemory.previousDNAs,
            );
          } else if (mode === "images") {
            aesthetic = await analyzeAesthetic(
              "uploaded images",
              [],
              uploadedImages.slice(0, 10),
              tasteMemory.previousDNAs,
              extraTextContext
            );
          } else {
            aesthetic = await textQueryToAesthetic(
              extraTextContext ?? "classic casual style",
              tasteMemory.previousDNAs
            );
          }
        }
        // At this point `aesthetic` is guaranteed to be assigned — either
        // by the cache short-circuit above or by one of the branches in the
        // `!aestheticCached` block. TS-flow can't see through the mutually-
        // exclusive paths, so we narrow with a runtime-impossible throw.
        if (!aesthetic!) throw new Error("aesthetic analysis produced no result");

        // Price-tier hard override (same logic as before the split).
        if (priceOverride) {
          console.log(`[shop] priceTier override: ${aesthetic.price_range} → ${priceOverride}`);
          aesthetic = { ...aesthetic, price_range: priceOverride };
        }

        // Category-filter hard override — when the search came from a
        // /shop category page (Tops, Dresses, etc.), force Claude's
        // focus_categories to the page's category. applyFocusSkew below
        // then drops every other bucket so the user gets only the
        // category they were browsing.
        if (forcedFocusCategories.length > 0) {
          console.log(`[shop] categoryFilter override: focus_categories → ${JSON.stringify(forcedFocusCategories)} (was ${JSON.stringify(aesthetic.focus_categories ?? null)})`);
          aesthetic = { ...aesthetic, focus_categories: forcedFocusCategories };
        }

        // ── EMIT: aesthetic phase ────────────────────────────────────────────
        // Client can now advance the loading dots and start animating the
        // aesthetic preview, even as the candidate fetch below runs.
        emit({ phase: "aesthetic", aesthetic, cached: aestheticCached });

        const allAvoids = [...(aesthetic.avoids ?? []), ...tasteMemory.softAvoids];

        // ── Product retrieval ────────────────────────────────────────────────
        let rawCandidates: import("@/lib/algolia").CategoryCandidates;

        if (USE_VISUAL_SEARCH && mode === "images" && uploadedImages?.length) {
          console.log("[shop] Hybrid search: uploaded images (with aesthetic anchor)");
          const rawEmb = await embedBase64Images(uploadedImages.slice(0, 10));
          const anchored = await anchorImageVectorsWithAesthetic(rawEmb, aesthetic!, tasteMemory.softAvoids);
          // 50 per category × 6 categories = 300 candidates before filters
          // (was 20 → ~120 → ~70 after avoids/mens-only filters). 50 lines
          // up with the CLIP centroid topK = 300 the rest of the pipeline
          // is sized around.
          rawCandidates  = await hybridSearch(anchored, aesthetic!, token, 50, { useTasteHead });

        } else if (USE_VISUAL_SEARCH && mode === "pinterest" && pinImageUrls?.length) {
          console.log("[shop] Hybrid search: Pinterest board images (parallel-embedded)");

          // Await the embedding that we kicked off in parallel with Claude.
          // If the cache-hit fast path skipped Claude entirely, the promise
          // is null and we embed now from the freshly-fetched images; else
          // the embed has been running in parallel and this is a ~0 s await.
          let embeddings: number[][];
          if (pinEmbeddingsPromise) {
            embeddings = await pinEmbeddingsPromise;
          } else {
            // Cache-hit path: no Claude call, no fetched images yet. Embed
            // here. Still cheaper than the old embedImageUrls-20-pins path
            // because we cap at 10 images.
            sharedPinImages = sharedPinImages.length ? sharedPinImages : await fetchPinImages(pinImageUrls.slice(0, 10));
            embeddings = await embedBase64Images(sharedPinImages);
          }

          const validEmbeddings = embeddings.filter((e) => e.length > 0);

          if (tasteMemory.styleCentroid && validEmbeddings.length > 0) {
            console.log("[shop] Blending cross-session style centroid");
            embeddings = validEmbeddings.map((emb) =>
              blendCentroids(emb, [tasteMemory.styleCentroid!], 0.15)
            );
          }

          embeddings = await anchorImageVectorsWithAesthetic(
            embeddings,
            aesthetic!,
            tasteMemory.softAvoids,
          );

          rawCandidates = await hybridSearch(embeddings, aesthetic!, token, 50, { useTasteHead });

        } else if (mode === "text") {
          // Text mode runs through the 2-stage retrieval pipeline
          // (lib/hybrid-search.twoStageStrictSearch):
          //
          //   Stage 1 — Algolia gate:
          //     searchByCategory pulls the FULL pool (no per-category cap,
          //     pagination through ~5000 hits per query) of items whose
          //     titles/brands/categories literal-match Claude's
          //     category_queries + style_keywords boost.
          //
          //   Stage 2 — FashionCLIP rerank:
          //     embedTextQuery(aesthetic.aesthetic_descriptor) — Claude's
          //     soft-only phrase ("summery breezy" / "y2k clubby"). Fetch
          //     (visual, vibe) vector pair for each Algolia candidate from
          //     Pinecone. Score = 0.8 × cos(qVec, pVisual) + 0.2 × cos(
          //     qVec, pVibe). Sort, take top maxPerCategory.
          //
          // This replaces the prior parallel-RRF approach where Algolia,
          // FashionCLIP visual, and FashionCLIP vibe all voted alongside
          // each other. The 2-stage shape cleanly separates hard literal
          // constraints (brand/color/garment) from soft semantic ones
          // (vibe/era/season) — and means an off-aesthetic Algolia hit
          // can no longer slip through just because it ranked high in
          // keyword match.
          //
          // We still produce buildTextQueryVectors as `fallbackEmbeddings`:
          // when Algolia returns < 30 hits the literal gate misfired and
          // twoStageStrictSearch falls back to the parallel-RRF
          // hybridSearch on the full catalog, which needs a query vector
          // ensemble.
          let fallbackEmbeddings: number[][] = [];
          try {
            fallbackEmbeddings = await buildTextQueryVectors(
              aesthetic!,
              tasteMemory.softAvoids,
            );
          } catch (e) {
            console.warn(
              `[shop] buildTextQueryVectors failed (mode=${mode}, fallback path):`,
              e instanceof Error ? e.message : e,
            );
          }

          console.log(`[shop] 2-stage strict search (mode=${mode}, descriptor="${(aesthetic!.aesthetic_descriptor ?? "").slice(0, 60)}")`);
          rawCandidates = await twoStageStrictSearch(
            aesthetic!,
            token,
            50,
            {
              fallbackEmbeddings,
              useTasteHead,
              // Pass the user's cross-session styleCentroid as a third
              // ranking axis. New users (no centroid) trigger the rerank's
              // weight-renormalization branch and the rerank degrades to
              // descriptor-only scoring.
              userCentroid: tasteMemory.styleCentroid,
              softAvoids:   tasteMemory.softAvoids,
              // Click signals feed the click-affinity bonus axis: structured
              // brand/color/retailer matches the centroid's visual signal
              // can't capture. Captures "I keep clicking Khaite" beyond
              // "I keep clicking things that look Khaite-like."
              clickSignals: tasteMemory.clickSignals,
              // Raw user query drives the (#3) classifier — controls whether
              // we run stage 1b at all and (#5) what MMR λ to use.
              userQuery: contexts[0].textQuery ?? "",
              debug,
            },
          );

        } else {
          console.log(`[shop] Algolia text search (mode=${mode}, Pinecone=${USE_VISUAL_SEARCH})`);
          rawCandidates = await fetchCandidateProductsByCategory(aesthetic!, token);
        }

        // Skew to focus categories when Claude flagged the board as
        // single-category (e.g. a 158-pin shoes board -> focus=['shoes']).
        // Non-focus buckets get capped so the downstream grid doesn't drown
        // the user's actual interest in filler from abundant categories
        // (dresses, mostly). No-op when focus_categories is unset.
        const afterFocus  = applyFocusSkew(rawCandidates, aesthetic?.focus_categories);
        const afterAvoids = filterByAvoids(afterFocus, allAvoids);
        const candidates  = filterMensItems(afterAvoids);

        // Persist StyleDNA (fire and forget) — only for fresh analyses, not
        // cache hits (the row we just read from is the same one we'd write).
        if (!aestheticCached && mode === "pinterest" && boardId && boardName) {
          void saveStyleDNA(token, boardId, boardName, aesthetic!)
            .catch((err) => console.warn("saveStyleDNA failed (non-fatal):", err));
        }

        // ── EMIT: candidates phase ──────────────────────────────────────────
        emit({ phase: "candidates", candidates, clickSignals: tasteMemory.clickSignals });

        // ── EMIT: done ──────────────────────────────────────────────────────
        emit({ phase: "done" });
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[shop] Failed:", message);
        try {
          emit({ phase: "error", detail: message });
        } catch { /* controller already closed */ }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":    "application/x-ndjson; charset=utf-8",
      // Prevent intermediaries (nginx, Vercel edge, some CDNs) from buffering
      // the stream — without this, the NDJSON events pile up and arrive in
      // one chunk at the end, defeating the whole progressive-reveal point.
      "Cache-Control":   "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
