/**
 * POST /api/onboarding/save
 *
 * One-shot submission of the onboarding "this or this" pair gauntlet.
 * Three completion shapes:
 *
 *   A. Full gauntlet  — user made N positive picks (target 50, but we
 *      accept anywhere from 1+). For each pick we read both products'
 *      pre-computed FashionCLIP vectors from Pinecone and build a
 *      preference centroid: avg(picked) − α × avg(rejected), L2-
 *      normalized. Stored as user_onboarding.upload_centroid (column
 *      name retained for backward compat — see migration for the original
 *      photo-upload-derived centroid).
 *
 *   B. Empty gauntlet — user clicked "neither" on every pair (or quit
 *      with zero picks). No centroid possible. Row lands with
 *      upload_centroid=null and skipped=true so the gate sees them as
 *      onboarded but the taste-profile lib falls back to age-only.
 *
 *   C. Skip-at-pairs — explicit `skip: true` flag, e.g. user closed the
 *      gauntlet without engaging. Same shape as (B).
 *
 * Why we replaced photo upload
 * -----------------------------
 *   The previous flow asked users to upload 1-8 photos across 4 outfit
 *   categories. Photos were FashionCLIP-embedded server-side and averaged
 *   into a centroid. Two problems:
 *     1. Friction — finding photos, dealing with HEIC, slow uploads.
 *        Most users either skipped or dropped off mid-flow.
 *     2. Signal noise — casual snapshots embed lighting + background +
 *        framing alongside the actual style, all noise relative to taste.
 *   The pair gauntlet replaces both: 50 taps at ~2 sec each = ~2 min of
 *   user time, vectors come from clean catalog photography (low noise),
 *   AND we get a negative signal from the rejected side that photos
 *   couldn't provide.
 *
 * Request body
 * ------------
 *   { userToken, ageRange, picks: [{ pickedId, rejectedId }] }   → path A
 *   { userToken, ageRange, picks: [] }                           → path B
 *   { userToken, ageRange, skip: true }                          → path C
 *
 * Response
 * --------
 *   200 { ok: true, skipped, centroidDim?, picks?: number, dropped?: number }
 *   400 { error: "..." }   on validation failure
 *   401 { error: "auth required" }   if userToken missing/anon
 *
 * Idempotent — `upsert` means re-running overwrites the previous row.
 */

import { NextResponse } from "next/server";
import { fetchProductsForCentroid } from "@/lib/embeddings";
import {
  saveOnboarding,
  isAgeRangeKey,
  type AgeRangeKey,
} from "@/lib/onboarding-memory";

export const runtime = "nodejs";
export const maxDuration = 30;

// Cap how many picks we accept per request. Even with the 50-pick UI
// target, a malicious / buggy client could try to ship arbitrary numbers;
// 200 is a generous ceiling.
const MAX_PICKS = 200;

// Negative-subtraction strength when blending picked − rejected. 0.3 is
// the same value we use elsewhere in the ranker (lib/taste-centroid
// applyNegativeSubtraction) so onboarding signal lives in the same
// space as session signals downstream.
const NEG_SUBTRACT_ALPHA = 0.3;

function l2Normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return v;
  return v.map((x) => x / norm);
}

function averageVectors(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0].length;
  if (dim === 0) return null;
  const out = new Array<number>(dim).fill(0);
  let n = 0;
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
    n++;
  }
  if (n === 0) return null;
  for (let i = 0; i < dim; i++) out[i] /= n;
  return out;
}

/** Compute preference centroid: positive minus alpha × negative, L2-norm. */
function buildPreferenceCentroid(
  positive: number[][],
  negative: number[][],
  alpha:    number,
): number[] | null {
  const pos = averageVectors(positive);
  if (!pos || pos.length === 0) return null;
  const neg = averageVectors(negative);
  if (!neg || neg.length !== pos.length) {
    // No valid negative pool — return the positive average alone. This
    // happens if every rejected vector failed to fetch (rare).
    return l2Normalize(pos);
  }
  const out = new Array<number>(pos.length);
  for (let i = 0; i < pos.length; i++) out[i] = pos[i] - alpha * neg[i];
  return l2Normalize(out);
}

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
  const picksRaw: unknown    = b.picks;
  const skip:      boolean   = b.skip === true;

  if (!userToken || userToken === "anon") {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }
  if (!isAgeRangeKey(ageRangeRaw)) {
    return NextResponse.json({ error: "Invalid or missing ageRange" }, { status: 400 });
  }
  const ageRange: AgeRangeKey = ageRangeRaw;

  // ── Path C: explicit skip ─────────────────────────────────────────────
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

  // ── Validate picks ────────────────────────────────────────────────────
  if (!Array.isArray(picksRaw)) {
    return NextResponse.json({ error: "picks must be an array" }, { status: 400 });
  }
  if (picksRaw.length > MAX_PICKS) {
    return NextResponse.json({ error: `Too many picks (max ${MAX_PICKS})` }, { status: 400 });
  }

  interface CleanPick { pickedId: string; rejectedId: string; }
  const picks: CleanPick[] = [];
  for (const p of picksRaw) {
    if (!p || typeof p !== "object") continue;
    const obj = p as Record<string, unknown>;
    const pickedId   = typeof obj.pickedId   === "string" ? obj.pickedId.trim()   : "";
    const rejectedId = typeof obj.rejectedId === "string" ? obj.rejectedId.trim() : "";
    if (!pickedId || !rejectedId || pickedId === rejectedId) continue;
    picks.push({ pickedId, rejectedId });
  }

  // ── Path B: zero positive picks (e.g. "neither" on every pair) ────────
  // Save as skipped so the gate marks the user onboarded but the ranker
  // falls back to age-only for taste signal. Same shape as the explicit
  // skip path — different reason in the row's interpretation but the
  // schema doesn't need to distinguish.
  if (picks.length === 0) {
    await saveOnboarding({
      userToken,
      ageRange,
      uploadCentroid: null,
      uploadVectors:  [],
      skipped:        true,
    });
    return NextResponse.json({
      ok:       true,
      skipped:  true,
      ageRange,
      picks:    0,
      message:  "Saved your age. Your feed will personalize as you browse.",
    });
  }

  // ── Path A: full or partial gauntlet — fetch vectors and compute centroid ─
  // One Pinecone fetch with all picked + rejected IDs. Pinecone returns
  // values + metadata; we ignore metadata here (only need vectors).
  const allIds = Array.from(new Set([
    ...picks.map((p) => p.pickedId),
    ...picks.map((p) => p.rejectedId),
  ]));
  const fetched = await fetchProductsForCentroid(allIds);
  const vectorById = new Map(fetched.map((r) => [r.id, r.vector] as const));

  const positive: number[][] = [];
  const negative: number[][] = [];
  let dropped = 0;
  for (const p of picks) {
    const pickedVec   = vectorById.get(p.pickedId);
    const rejectedVec = vectorById.get(p.rejectedId);
    // Only count a pick if BOTH sides resolved. A half-resolved pick
    // would bias the centroid (positive without its matched negative or
    // vice versa). Better to drop than skew.
    if (pickedVec && rejectedVec && pickedVec.length > 0 && rejectedVec.length > 0) {
      positive.push(pickedVec);
      negative.push(rejectedVec);
    } else {
      dropped++;
    }
  }

  if (positive.length === 0) {
    // All vectors failed to fetch — likely a Pinecone outage or stale
    // product IDs. Save as skipped so the user isn't blocked. Ranking
    // gracefully falls back to age-only.
    console.warn(`[onboarding/save] all ${picks.length} picks failed to resolve vectors; saving as skipped`);
    await saveOnboarding({
      userToken,
      ageRange,
      uploadCentroid: null,
      uploadVectors:  [],
      skipped:        true,
    });
    return NextResponse.json({
      ok:        true,
      skipped:   true,
      ageRange,
      picks:     picks.length,
      dropped:   picks.length,
      message:   "Saved your age. Some of the picks couldn't be processed, but your feed will sharpen as you browse.",
    });
  }

  const centroid = buildPreferenceCentroid(positive, negative, NEG_SUBTRACT_ALPHA);
  if (!centroid) {
    return NextResponse.json({ error: "Failed to compute preference centroid" }, { status: 500 });
  }

  // ── Persist ─────────────────────────────────────────────────────────────
  // upload_vectors keeps the per-pick POSITIVE vectors only — these are
  // what historically lived there (one vector per uploaded photo). The
  // negative side gets baked into the centroid but isn't kept around;
  // future training on this row would only see what the user picked,
  // which is the right signal for downstream taste-head training.
  await saveOnboarding({
    userToken,
    ageRange,
    uploadCentroid: centroid,
    uploadVectors:  positive,
    skipped:        false,
  });

  return NextResponse.json({
    ok:          true,
    skipped:     false,
    centroidDim: centroid.length,
    picks:       positive.length,
    dropped,
    ageRange,
  });
}
