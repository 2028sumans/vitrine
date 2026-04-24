/**
 * POST /api/onboarding/save
 *
 * One-shot submission of the onboarding quiz answers.
 *
 * Request body
 * ------------
 *   {
 *     userToken: string,              // session.user.id from next-auth
 *     ageRange:  "age-13-18" | ...,   // must be in AGE_RANGE_KEYS
 *     images: [{ base64, mimeType }, ...],  // up to ~16 uploads, client-side already
 *                                           // capped to 1-2 per of 4 categories.
 *                                           // Category metadata isn't sent — with
 *                                           // the "one centroid" design (user's
 *                                           // Q3 answer), we just average everything.
 *   }
 *
 * Response
 * --------
 *   200 { ok: true, centroidDim: 512, embedded: <count> }
 *   400 { error: "..." }  on validation failure
 *   401 { error: "auth required" }  if userToken missing/anon
 *   500 { error: "..." }  on embed / DB failure
 *
 * Flow
 * ----
 *   1. Validate userToken, ageRange, images[].
 *   2. FashionCLIP-embed each image in parallel (lib/embeddings.embedBase64Images).
 *   3. Average into a 512-dim centroid (lib/taste-profile.averageVectors).
 *   4. Upsert {age_range, upload_centroid, upload_vectors, completed_at} into
 *      user_onboarding (lib/onboarding-memory.saveOnboarding).
 *
 * Keep the route idempotent — `upsert` means re-submitting the quiz overwrites
 * the previous answer cleanly. We don't treat that as a special case.
 */

import { NextResponse } from "next/server";
import type { VisionImage } from "@/lib/types";
import { embedBase64Images } from "@/lib/embeddings";
import { averageVectors } from "@/lib/taste-profile";
import {
  saveOnboarding,
  isAgeRangeKey,
  type AgeRangeKey,
} from "@/lib/onboarding-memory";

// Guard against abuse / accidental huge uploads. The client caps at 1-2 per
// of 4 categories = 8 images; we give ourselves 2x headroom.
const MAX_IMAGES = 16;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const userToken: string    = typeof b.userToken === "string" ? b.userToken.trim() : "";
  const ageRangeRaw: unknown = b.ageRange;
  const imagesRaw: unknown   = b.images;

  if (!userToken || userToken === "anon") {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }
  if (!isAgeRangeKey(ageRangeRaw)) {
    return NextResponse.json({ error: "Invalid or missing ageRange" }, { status: 400 });
  }
  const ageRange: AgeRangeKey = ageRangeRaw;

  if (!Array.isArray(imagesRaw)) {
    return NextResponse.json({ error: "images must be an array" }, { status: 400 });
  }
  if (imagesRaw.length === 0) {
    return NextResponse.json({ error: "At least one image is required" }, { status: 400 });
  }
  if (imagesRaw.length > MAX_IMAGES) {
    return NextResponse.json({ error: `Too many images (max ${MAX_IMAGES})` }, { status: 400 });
  }

  // Narrow each image to { base64, mimeType } and drop any that don't look
  // like a real upload. Empty base64 / unsupported mime gets filtered here
  // instead of failing downstream in the embed call.
  const images: VisionImage[] = [];
  for (const item of imagesRaw) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    const base64   = typeof i.base64   === "string" ? i.base64   : "";
    const mimeType = typeof i.mimeType === "string" ? i.mimeType : "";
    if (!base64 || !mimeType.startsWith("image/")) continue;
    images.push({ base64, mimeType });
  }
  if (images.length === 0) {
    return NextResponse.json({ error: "No valid images after validation" }, { status: 400 });
  }

  // ── Embed ───────────────────────────────────────────────────────────────
  // embedBase64Images returns one vector per input, with empty arrays for
  // images that failed. Filter out empties before averaging.
  let vectors: number[][];
  try {
    vectors = await embedBase64Images(images);
  } catch (err) {
    console.error("[onboarding/save] embed failed:", err);
    return NextResponse.json({ error: "Embedding failed" }, { status: 500 });
  }
  const goodVectors = vectors.filter((v) => Array.isArray(v) && v.length > 0);
  if (goodVectors.length === 0) {
    return NextResponse.json({ error: "All images failed to embed — try different photos" }, { status: 500 });
  }

  const centroid = averageVectors(goodVectors);
  if (!centroid || centroid.length === 0) {
    // averageVectors only returns null on pathological input; we already
    // filtered empties, so this path is theoretically unreachable. Belt-
    // and-braces so a future refactor can't break things silently.
    return NextResponse.json({ error: "Failed to compute centroid" }, { status: 500 });
  }

  // ── Persist ─────────────────────────────────────────────────────────────
  await saveOnboarding({
    userToken,
    ageRange,
    uploadCentroid: centroid,
    uploadVectors:  goodVectors,
  });

  return NextResponse.json({
    ok:          true,
    centroidDim: centroid.length,
    embedded:    goodVectors.length,
    ageRange,
  });
}
