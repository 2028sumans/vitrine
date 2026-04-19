/**
 * "More like this" — fired when a user likes a card.
 *
 * 1. Fetch FashionCLIP-similar products from Pinecone using the liked items'
 *    own vectors (already in the index, so no re-embedding needed).
 * 2. Hydrate the IDs back to AlgoliaProduct objects.
 * 3. Filter out avoids + men's items + already-shown IDs.
 * 4. Curate them into outfit cards via the existing curate pipeline.
 *
 * Returns the curated products in the same shape as /api/curate so the
 * client can drop them into scrollCards with no transformation.
 *
 * Designed to be fired async on every like — the user keeps swiping and
 * new cards land in their queue ahead of them when the response arrives.
 */

import { NextResponse }                          from "next/server";
import { curateProducts, fetchCandidateProductsByCategory, filterByAvoids, filterMensItems } from "@/lib/ai";
import { searchByLikedProductIds }               from "@/lib/embeddings";
import { hybridSearch }                          from "@/lib/hybrid-search";
import { buildTextQueryVectors }                 from "@/lib/query-builder";
import { getProductsByIds, groupByCategory }     from "@/lib/algolia";
import { loadTasteMemory }                       from "@/lib/taste-memory";
import type { StyleDNA }                         from "@/lib/types";

const USE_VISUAL_SEARCH = !!(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX);

const SIMILAR_FETCH_K = 30; // pull 30 similar; curation will narrow to 4-6

export async function POST(request: Request) {
  const body = await request.json();
  const {
    likedProductIds,
    aesthetic,
    userToken,
    excludeIds = [],
  } = body as {
    likedProductIds: string[];
    aesthetic:       StyleDNA;
    userToken?:      string;
    excludeIds?:     string[];
  };

  if (!Array.isArray(likedProductIds) || likedProductIds.length === 0) {
    return NextResponse.json({ error: "likedProductIds required" }, { status: 400 });
  }
  if (!aesthetic) {
    return NextResponse.json({ error: "aesthetic required" }, { status: 400 });
  }

  const token = userToken || "anon";
  const tasteMemory = await loadTasteMemory(token).catch(() => ({ clickSignals: [], softAvoids: [] as string[] }));
  const allAvoids   = [...(aesthetic.avoids ?? []), ...tasteMemory.softAvoids];

  try {
    // 1. Try Pinecone vector similarity from liked products (already-embedded vectors)
    const similarIds = await searchByLikedProductIds(
      likedProductIds,
      SIMILAR_FETCH_K,
      { priceRange: aesthetic.price_range },
      [...likedProductIds, ...excludeIds],
    );
    console.log(`[similar-on-like] Pinecone returned ${similarIds.length} similar IDs for ${likedProductIds.length} liked`);

    // 2. Hydrate to products. If Pinecone had no vectors for these liked items
    //    (embed script still running, ~30% of catalog indexed), fall back to
    //    biasing the aesthetic with the liked items' attributes and running
    //    the same hybrid text search the /api/shop route uses.
    let grouped;
    if (similarIds.length > 0) {
      const products = await getProductsByIds(similarIds);
      grouped = groupByCategory(products, 12);
    } else {
      console.log("[similar-on-like] Pinecone miss — falling back to aesthetic-biased search");
      // Hydrate the LIKED products to get their attributes, then bias the
      // aesthetic toward them so the fallback search pulls in-neighborhood items.
      const likedProducts = await getProductsByIds(likedProductIds).catch(() => []);
      const biasedDNA: StyleDNA = {
        ...aesthetic,
        style_keywords: [
          ...(aesthetic.style_keywords ?? []),
          ...likedProducts.flatMap((p) => [p.brand, p.color, p.category]
            .filter((s): s is string => typeof s === "string" && s.length > 0)),
        ].slice(0, 12),
      };
      if (USE_VISUAL_SEARCH) {
        const queryVectors = await buildTextQueryVectors(biasedDNA, tasteMemory.softAvoids);
        const hybrid = await hybridSearch(queryVectors, biasedDNA, token);
        grouped = hybrid;
      } else {
        grouped = await fetchCandidateProductsByCategory(biasedDNA, token);
      }
      // Strip anything the user has already seen
      const seen = new Set(excludeIds);
      for (const cat of Object.keys(grouped) as Array<keyof typeof grouped>) {
        grouped[cat] = grouped[cat].filter((p) => !seen.has(p.objectID));
      }
    }

    // 3. Filter
    const filtered = filterMensItems(filterByAvoids(grouped, allAvoids));

    // 4. Curate into 1-2 outfit cards via Claude
    const curated = await curateProducts(
      aesthetic,
      filtered,
      [],                              // no board images at like-time
      tasteMemory.clickSignals ?? [],
      "",                              // skip trends block — we're being responsive, not seasonal
    );

    const totalBucketed = Object.values(filtered).reduce((s, arr) => s + arr.length, 0);
    console.log(
      `[similar-on-like] liked=${likedProductIds.length} pinecone=${similarIds.length} ` +
      `bucketed=${totalBucketed} curated=${curated.products.length}`,
    );

    return NextResponse.json({
      products:       curated.products,
      outfit_a_role:  curated.outfit_a_role,
      outfit_b_role:  curated.outfit_b_role,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[similar-on-like] Failed:", message);
    return NextResponse.json({ error: "Failed", detail: message }, { status: 500 });
  }
}
