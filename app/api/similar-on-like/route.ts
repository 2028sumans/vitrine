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
import { curateProducts, filterByAvoids, filterMensItems } from "@/lib/ai";
import { searchByLikedProductIds }               from "@/lib/embeddings";
import { getProductsByIds, groupByCategory }     from "@/lib/algolia";
import { loadTasteMemory }                       from "@/lib/taste-memory";
import type { StyleDNA }                         from "@/lib/types";

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

  try {
    // 1. Pinecone vector similarity from liked products (already-embedded vectors)
    const similarIds = await searchByLikedProductIds(
      likedProductIds,
      SIMILAR_FETCH_K,
      aesthetic.price_range,
      [...likedProductIds, ...excludeIds],
    );

    if (similarIds.length === 0) {
      console.log("[similar-on-like] no similar items found in Pinecone");
      return NextResponse.json({ products: [] });
    }

    // 2. Hydrate to full Algolia products
    const products = await getProductsByIds(similarIds);
    if (products.length === 0) {
      return NextResponse.json({ products: [] });
    }

    // 3. Filter and bucket by category
    const tasteMemory = await loadTasteMemory(token).catch(() => ({ clickSignals: [], softAvoids: [] as string[] }));
    const allAvoids   = [...(aesthetic.avoids ?? []), ...tasteMemory.softAvoids];
    const grouped     = groupByCategory(products, 12);
    const filtered    = filterMensItems(filterByAvoids(grouped, allAvoids));

    // 4. Curate into 1-2 outfit cards via Claude
    const curated = await curateProducts(
      aesthetic,
      filtered,
      [],                              // no board images at like-time
      tasteMemory.clickSignals ?? [],
      "",                              // skip trends block — we're being responsive, not seasonal
    );

    console.log(
      `[similar-on-like] liked=${likedProductIds.length} similar=${similarIds.length} ` +
      `hydrated=${products.length} curated=${curated.products.length}`,
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
