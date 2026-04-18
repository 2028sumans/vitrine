/**
 * POST /api/more-outfits
 *
 * Called when the user nears the end of their scroll queue. Fetches a fresh
 * batch of catalog products — excluding everything already shown — runs them
 * through Claude curation, and returns new outfit data ready for the client
 * to turn into OutfitCards.
 *
 * Key difference from /api/curate:
 *   - /api/curate re-curates from the original ~120 candidates
 *     (exhaustible — eventually scroll stops)
 *   - /api/more-outfits hits hybrid search AGAIN with excludeIds to pull a
 *     genuinely fresh pool from the full catalog, then curates that pool.
 *     Enables effectively unbounded scroll.
 *
 * Two parallel curate calls = up to 4 fresh outfit cards per invocation.
 */

import { NextResponse }                              from "next/server";
import {
  curateProducts,
  fetchCandidateProductsByCategory,
  filterByAvoids,
  filterMensItems,
}                                                    from "@/lib/ai";
import { hybridSearch }                              from "@/lib/hybrid-search";
import { buildTextQueryVectors }                     from "@/lib/query-builder";
import { loadTasteMemory }                           from "@/lib/taste-memory";
import type { StyleDNA }                             from "@/lib/types";
import type { CategoryCandidates, ClothingCategory } from "@/lib/algolia";

const USE_VISUAL_SEARCH = !!(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX);
const CATEGORIES: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];

// Each batch = one curateProducts call = up to 2 outfits. Two batches in
// parallel = up to 4 outfit cards per invocation. Plenty of material between
// user hitting near-end and the next invocation.
const PARALLEL_BATCHES = 2;

// Pull a wider pool than /api/shop to reduce dupes with already-shown items.
const MAX_PER_CATEGORY = 30;

export async function POST(request: Request) {
  const { aesthetic, excludeIds = [], userToken }: {
    aesthetic:   StyleDNA;
    excludeIds?: string[];
    userToken?:  string;
  } = await request.json();

  if (!aesthetic) {
    return NextResponse.json({ error: "Missing aesthetic" }, { status: 400 });
  }

  const token = userToken || "anon";

  try {
    const tasteMemory = await loadTasteMemory(token).catch(() => ({
      clickSignals: [],
      softAvoids:   [] as string[],
    }));

    // 1. Fresh pool from the full catalog — bigger per-category cap than
    //    the initial /api/shop call so dedup doesn't wipe everything.
    let rawCandidates: CategoryCandidates;
    if (USE_VISUAL_SEARCH) {
      const queryVectors = await buildTextQueryVectors(aesthetic, tasteMemory.softAvoids);
      rawCandidates = await hybridSearch(queryVectors, aesthetic, token, MAX_PER_CATEGORY);
    } else {
      rawCandidates = await fetchCandidateProductsByCategory(aesthetic, token);
    }

    // 2. Strip anything the user has already seen
    const excl = new Set(excludeIds);
    for (const cat of CATEGORIES) {
      rawCandidates[cat] = rawCandidates[cat].filter((p) => !excl.has(p.objectID));
    }

    // 3. Filter avoids + men's items
    const allAvoids = [...(aesthetic.avoids ?? []), ...(tasteMemory.softAvoids ?? [])];
    const filtered  = filterMensItems(filterByAvoids(rawCandidates, allAvoids));

    const poolSize = CATEGORIES.reduce((s, c) => s + filtered[c].length, 0);
    console.log(`[more-outfits] pool after exclude(${excludeIds.length}) + filters = ${poolSize}`);

    // 4. Need at least ~12 items for Claude to compose 2 outfits. If we're
    //    below that, the catalog for this aesthetic is effectively exhausted.
    if (poolSize < 12) {
      return NextResponse.json({ batches: [], exhausted: true });
    }

    // 5. Curate N parallel batches. Each call to Claude sees the same pool
    //    but outfit selection has enough randomness to produce variety; the
    //    client dedups near-duplicates.
    const curations = await Promise.all(
      Array.from({ length: PARALLEL_BATCHES }, () =>
        curateProducts(aesthetic, filtered, [], tasteMemory.clickSignals ?? [], "")
          .catch((err) => {
            console.warn("[more-outfits] a batch failed:", err instanceof Error ? err.message : err);
            return null;
          }),
      ),
    );

    const batches = curations
      .filter((c): c is NonNullable<typeof c> => c != null)
      .map((c) => ({
        products:        c.products,
        outfit_a_role:   c.outfit_a_role ?? "",
        outfit_b_role:   c.outfit_b_role ?? "",
      }));

    return NextResponse.json({ batches, exhausted: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[more-outfits] Failed:", message);
    return NextResponse.json({ error: "Failed", detail: message }, { status: 500 });
  }
}
