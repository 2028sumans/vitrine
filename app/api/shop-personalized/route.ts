/**
 * POST /api/shop-personalized
 *
 * Takes a list of Pinterest pin image URLs, embeds them with FashionCLIP
 * server-side, queries Pinecone for the top N visually-similar catalog
 * products, and returns them as a personalized shop feed.
 *
 * Used by /shop when the signed-in user has fashion boards we could read
 * via /api/pinterest/fashion-boards. Falls back gracefully: if no valid
 * embeddings could be produced (e.g. Pinterest CDN unreachable, or the
 * FashionCLIP model failed to load), returns { products: [] } and the
 * client falls back to the flat /api/shop-all feed.
 *
 * Latency: ~10-20s on cold start (model load), ~2-5s warm. Clients should
 * present a "personalizing..." state while this runs.
 */

import { NextResponse }                  from "next/server";
import { embedImageUrls, searchByEmbeddings } from "@/lib/embeddings";
import { getProductsByIds }              from "@/lib/algolia";

const MAX_PINS_TO_EMBED = 20;  // caps embedding cost on the server
const TOP_K             = 120; // how many similar products to return

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const pinImageUrls: string[] = Array.isArray(body?.pinImageUrls) ? body.pinImageUrls : [];

  if (pinImageUrls.length === 0) {
    return NextResponse.json({ products: [] });
  }

  // Cap inputs so a huge board collection doesn't stall the function
  const urls = pinImageUrls.slice(0, MAX_PINS_TO_EMBED);

  try {
    // 1. Embed pins via FashionCLIP vision (server-side, reuses the same
    //    pipeline the dashboard uses for Pinterest boards)
    const embeddings = await embedImageUrls(urls);
    const valid = embeddings.filter((e) => e.length > 0);
    if (valid.length === 0) {
      console.log("[shop-personalized] no valid embeddings — likely model or CDN failure");
      return NextResponse.json({ products: [] });
    }

    // 2. Pinecone similarity search — returns objectIDs sorted by score
    const productIds = await searchByEmbeddings(valid, TOP_K);
    if (productIds.length === 0) {
      return NextResponse.json({ products: [] });
    }

    // 3. Hydrate IDs → full Algolia products. searchByEmbeddings preserves
    //    ranking, so don't re-sort; getProductsByIds may return in a different
    //    order, so we rebuild the array in the original ranked order.
    const raw = await getProductsByIds(productIds);
    const byId = new Map(raw.map((p) => [p.objectID, p]));
    const ordered = productIds
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => p != null);

    // Drop products with broken image URLs (same filter /api/shop-all uses)
    const clean = ordered.filter((p) => typeof p.image_url === "string" && p.image_url.startsWith("http"));

    return NextResponse.json({
      products: clean,
      pinsUsed: valid.length,
      total:    clean.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shop-personalized] failed:", message);
    // Non-fatal — client falls back to /api/shop-all
    return NextResponse.json({ products: [], error: message });
  }
}
