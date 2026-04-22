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
 * The request body is small JSON, not multipart — matches the pattern used
 * by /api/analyze for Pinterest uploads. Client sends { image: { base64, mimeType } }.
 */

import { NextResponse } from "next/server";
import { searchByUploadedImages } from "@/lib/embeddings";
import { getProductsByIds } from "@/lib/algolia";
import type { VisionImage } from "@/lib/types";

// Over-fetch so we can drop the inevitable Pinecone hits whose Algolia record
// was deleted during a QC cleanup, and still surface a full twin + alternates set.
const FETCH_K = 24;

interface TwinRequest {
  image: VisionImage;
}

export async function POST(request: Request) {
  let body: TwinRequest;
  try {
    body = (await request.json()) as TwinRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { image } = body;
  if (!image?.base64 || !image?.mimeType) {
    return NextResponse.json(
      { error: "image.base64 and image.mimeType required" },
      { status: 400 },
    );
  }

  try {
    const ids = await searchByUploadedImages([image], FETCH_K);
    if (ids.length === 0) {
      return NextResponse.json(
        { error: "no twin found — try a clearer photo of the garment" },
        { status: 404 },
      );
    }

    const products = await getProductsByIds(ids);
    if (products.length === 0) {
      return NextResponse.json(
        { error: "no twin found — try a clearer photo of the garment" },
        { status: 404 },
      );
    }

    const [twin, ...rest] = products;
    return NextResponse.json({
      twin,
      alternates: rest.slice(0, 5),
    });
  } catch (err) {
    console.error("[/api/twin] error:", err);
    return NextResponse.json(
      { error: "twin lookup failed" },
      { status: 500 },
    );
  }
}
