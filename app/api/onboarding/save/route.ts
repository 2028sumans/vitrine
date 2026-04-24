/**
 * POST /api/onboarding/save
 *
 * One-shot submission of the onboarding quiz answers. Two paths:
 *
 *   A. Full completion  — user uploaded 1+ outfit photos on the upload step.
 *      We FashionCLIP-embed each, average into a centroid, persist with
 *      skipped=false.
 *
 *   B. Skip-at-upload   — user picked an age but hit "Skip for now" on the
 *      upload step. No images to embed, no centroid. We still write a row
 *      (age_range populated, upload_centroid=null, skipped=true) so the
 *      onboarding gate sees them as "already dealt with this" and doesn't
 *      re-prompt on every login. Taste ranking falls back to just the age
 *      centroid (and later, any session signals).
 *
 * Request body
 * ------------
 *   { userToken, ageRange, images: [...] }               → path A
 *   { userToken, ageRange, skip: true }                  → path B (images optional / ignored)
 *
 * Response
 * --------
 *   200 { ok: true, skipped: boolean, centroidDim?: number, embedded?: number }
 *   400 { error: "..." }  on validation failure
 *   401 { error: "auth required" }  if userToken missing/anon
 *   500 { error: "..." }  on embed / DB failure
 *
 * Idempotent — `upsert` means re-submitting overwrites the previous row cleanly.
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
  const skip:      boolean   = b.skip === true;

  if (!userToken || userToken === "anon") {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }
  if (!isAgeRangeKey(ageRangeRaw)) {
    return NextResponse.json({ error: "Invalid or missing ageRange" }, { status: 400 });
  }
  const ageRange: AgeRangeKey = ageRangeRaw;

  // ── Path B: skip at the upload step ───────────────────────────────────
  // Accept the age but skip the embed + centroid work. The row lands with
  // upload_centroid=null and skipped=true so the gate recognises them as
  // onboarded (no re-prompt) while the taste-profile lib knows there's no
  // personal upload signal.
  if (skip) {
    await saveOnboarding({
      userToken,
      ageRange,
      uploadCentroid: null,
      uploadVectors:  [],
      skipped:        true,
    });
    return NextResponse.json({ ok: true, skipped: true, ageRange });
  }

  // ── Path A: full completion ───────────────────────────────────────────
  if (!Array.isArray(imagesRaw)) {
    return NextResponse.json({ error: "images must be an array" }, { status: 400 });
  }
  if (imagesRaw.length === 0) {
    // Not a skip (client didn't set the flag) AND no images — treat as a
    // validation miss. The UI should always set `skip: true` when sending
    // an empty array, so this only fires on malformed clients.
    return NextResponse.json({ error: "At least one image is required (or pass skip: true)" }, { status: 400 });
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
    skipped:        false,
  });

  return NextResponse.json({
    ok:          true,
    skipped:     false,
    centroidDim: centroid.length,
    embedded:    goodVectors.length,
    ageRange,
  });
}
