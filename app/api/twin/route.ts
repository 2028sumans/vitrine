/**
 * /api/twin — "Find its Twin"
 *
 * Fast-fashion → slow-fashion matcher. Takes an uploaded product image
 * (Zara, Shein, H&M screenshot, Instagram save, a photo of something in a
 * shop window, whatever) and returns the closest match from the Muse catalog,
 * which is already curated to small-batch / artisan / independent brands.
 *
 *   1. Embed the uploaded image with FashionCLIP (same model as the index).
 *   2. kNN against the default (visual) Pinecone namespace.
 *   3. Hydrate top-N IDs to AlgoliaProduct records.
 *   4. Return the best match as `twin` and a handful of alternates for the
 *      "show me another" shuffle.
 *
 * Accepts either shape of payload:
 *   { image: { base64, mimeType } }                — used by /twin web UI
 *   { imageUrl: "https://…" }                     — used by the Chrome extension
 *
 * CORS is open (`*`) so the browser extension can call this endpoint from its
 * `chrome-extension://…` origin. The endpoint is inherently public (no auth,
 * read-only over public catalog data) so this is fine for launch; tighten to
 * an explicit allowlist once we add auth or rate-limiting.
 */

import { NextResponse } from "next/server";
import {
  searchByUploadedImages,
  searchByBoardImages,
} from "@/lib/embeddings";
import { getProductsByIds } from "@/lib/algolia";
import type { VisionImage } from "@/lib/types";

// Over-fetch so we can drop the inevitable Pinecone hits whose Algolia record
// was deleted during a QC cleanup, and still surface a full twin + alternates set.
const FETCH_K = 24;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age":       "86400",
};

interface TwinRequest {
  image?:    VisionImage;
  imageUrl?: string;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: Request) {
  let body: TwinRequest;
  try {
    body = (await request.json()) as TwinRequest;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const { image, imageUrl } = body;
  if (!image?.base64 && !imageUrl) {
    return json({ error: "image.{base64,mimeType} or imageUrl required" }, 400);
  }

  try {
    const ids = imageUrl
      ? await searchByBoardImages([imageUrl], FETCH_K)
      : await searchByUploadedImages([image!], FETCH_K);

    if (ids.length === 0) {
      return json(
        { error: "no twin found — try a clearer photo of the garment" },
        404,
      );
    }

    const products = await getProductsByIds(ids);
    if (products.length === 0) {
      return json(
        { error: "no twin found — try a clearer photo of the garment" },
        404,
      );
    }

    const [twin, ...rest] = products;
    return json({
      twin,
      alternates: rest.slice(0, 5),
    });
  } catch (err) {
    console.error("[/api/twin] error:", err);
    return json({ error: "twin lookup failed" }, 500);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}
