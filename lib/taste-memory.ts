// ── Taste Memory ──────────────────────────────────────────────────────────────
// Persistent taste model per user. Three layers:
//   1. StyleDNA history   — what boards have taught us so far
//   2. Click signals      — products the user actually wanted (positive)
//   3. Product impressions — products shown but ignored (source of soft avoids)

import { getServiceSupabase } from "@/lib/supabase";
import type { StyleDNA, ClickSignal, TasteMemory } from "@/lib/types";

// Re-export from shared types so consumers can import from either place
export type { ClickSignal, TasteMemory } from "@/lib/types";

// ── StyleDNA history ──────────────────────────────────────────────────────────

export async function saveStyleDNA(
  userToken: string,
  boardId:   string,
  boardName: string,
  dna:       StyleDNA
): Promise<void> {
  const sb = getServiceSupabase();
  await sb.from("user_style_dnas").insert({
    user_token: userToken,
    board_id:   boardId,
    board_name: boardName,
    style_dna:  dna,
  });
}

export async function getPreviousStyleDNAs(
  userToken: string,
  limit = 5
): Promise<Array<{ board_name: string; dna: StyleDNA; created_at: string }>> {
  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from("user_style_dnas")
    .select("board_name, style_dna, created_at")
    .eq("user_token", userToken)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data
    .filter((row) => row.style_dna && row.board_name)
    .map((row) => ({
      board_name: (row.board_name as string) ?? "",
      dna:        row.style_dna as StyleDNA,
      created_at: (row.created_at as string) ?? "",
    }));
}

// ── Click signals ─────────────────────────────────────────────────────────────

export async function saveClickSignal(
  userToken: string,
  product: {
    objectID:   string;
    title:      string;
    brand:      string;
    color:      string;
    category?:  string;
    retailer:   string;
    price_range: string;
    image_url:  string;
  }
): Promise<void> {
  const sb = getServiceSupabase();
  await sb.from("taste_signals").insert({
    user_token:  userToken,
    object_id:   product.objectID,
    title:       product.title,
    brand:       product.brand,
    color:       product.color,
    category:    product.category ?? "",
    retailer:    product.retailer,
    price_range: product.price_range,
    image_url:   product.image_url,
  });
}

export async function getClickSignals(
  userToken: string,
  limit = 15
): Promise<ClickSignal[]> {
  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from("taste_signals")
    .select("object_id, title, brand, color, category, retailer, price_range, image_url, clicked_at")
    .eq("user_token", userToken)
    .order("clicked_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data.filter((row) => row.object_id) as ClickSignal[];
}

// ── Product impressions ───────────────────────────────────────────────────────

export async function saveImpressions(
  userToken: string,
  sessionId: string,
  products:  Array<{
    objectID:  string;
    title:     string;
    brand:     string;
    color:     string;
    category?: string;
    dwellMs?:  number | null;
  }>
): Promise<void> {
  if (!products.length) return;
  const sb = getServiceSupabase();
  await sb.from("product_impressions").insert(
    products.map((p) => ({
      user_token: userToken,
      session_id: sessionId,
      object_id:  p.objectID,
      title:      p.title,
      brand:      p.brand,
      color:      p.color,
      category:   p.category ?? "",
      dwell_ms:   typeof p.dwellMs === "number" ? Math.max(0, Math.round(p.dwellMs)) : null,
    }))
  );
}

// Scroll views fire an impression when a card first enters the viewport,
// then fire a dwell update when the user scrolls past it. Takes the MAX
// dwell seen — scrolling back to the same card shouldn't reduce the value.
//
// Match strategy: (user_token, session_id, object_id) first; fall back to
// the latest (user_token, object_id) when session_id doesn't match. This
// tolerates cases where the client's scroll-view session_id differs from
// the server's curate-time session_id (the impression was inserted by
// /api/curate under a boardId-timestamp key, not the client's random id).
export async function updateImpressionDwell(
  userToken: string,
  sessionId: string,
  objectId:  string,
  dwellMs:   number,
): Promise<void> {
  if (!userToken || !objectId) return;
  if (!Number.isFinite(dwellMs) || dwellMs < 0) return;
  const sb = getServiceSupabase();

  // Preferred: exact session match.
  type ImpressionRow = { id: number; dwell_ms: number | null };
  let row: ImpressionRow | null = null;
  if (sessionId) {
    const { data } = await sb
      .from("product_impressions")
      .select("id, dwell_ms")
      .eq("user_token", userToken)
      .eq("session_id", sessionId)
      .eq("object_id",  objectId)
      .order("id", { ascending: false })
      .limit(1);
    if (data?.length) row = data[0] as unknown as ImpressionRow;
  }
  // Fallback: latest impression row for (user, object) regardless of session.
  if (!row) {
    const { data } = await sb
      .from("product_impressions")
      .select("id, dwell_ms")
      .eq("user_token", userToken)
      .eq("object_id",  objectId)
      .order("id", { ascending: false })
      .limit(1);
    if (data?.length) row = data[0] as unknown as ImpressionRow;
  }
  if (!row) return;

  const current = row.dwell_ms ?? 0;
  if (dwellMs <= current) return;
  await sb
    .from("product_impressions")
    .update({ dwell_ms: Math.round(dwellMs) })
    .eq("id", row.id);
}

// ── Soft avoids ───────────────────────────────────────────────────────────────
// Products shown in ≥2 different sessions and never clicked → soft avoid.
// We extract color and brand patterns from those products and return them
// as human-readable avoid phrases that feed into Claude's context.

export async function computeSoftAvoids(userToken: string): Promise<string[]> {
  const sb = getServiceSupabase();

  // 1. Get all objectIDs the user has actually clicked
  const { data: clickData } = await sb
    .from("taste_signals")
    .select("object_id")
    .eq("user_token", userToken);

  const clickedIds = new Set((clickData ?? []).map((r) => r.object_id as string));

  // 2. Get impression counts per product across distinct sessions
  const { data: impressionData } = await sb
    .from("product_impressions")
    .select("object_id, session_id, color, brand, category, title")
    .eq("user_token", userToken);

  if (!impressionData?.length) return [];

  // 3. Group by objectID, count distinct sessions
  type ProductMeta = { color: string; brand: string; category: string; title: string; sessions: Set<string> };
  const byProduct = new Map<string, ProductMeta>();

  for (const row of impressionData) {
    const id = row.object_id as string;
    if (!byProduct.has(id)) {
      byProduct.set(id, {
        color:    (row.color as string) || "",
        brand:    (row.brand as string) || "",
        category: (row.category as string) || "",
        title:    (row.title as string) || "",
        sessions: new Set(),
      });
    }
    byProduct.get(id)!.sessions.add(row.session_id as string);
  }

  // 4. Products shown in ≥2 sessions and never clicked
  const ignored = Array.from(byProduct.entries())
    .filter(([id, meta]) => meta.sessions.size >= 2 && !clickedIds.has(id))
    .map(([, meta]) => meta);

  if (!ignored.length) return [];

  // 5. Extract patterns: what colors / brands / categories are consistently ignored?
  const colorFreq:    Record<string, number> = {};
  const brandFreq:    Record<string, number> = {};
  const categoryFreq: Record<string, number> = {};

  for (const p of ignored) {
    const color = p.color.toLowerCase().trim();
    const brand = p.brand.trim();
    const cat   = p.category.toLowerCase().trim();

    if (color && color !== "unknown") colorFreq[color]    = (colorFreq[color]    ?? 0) + 1;
    if (brand)                        brandFreq[brand]    = (brandFreq[brand]    ?? 0) + 1;
    if (cat)                          categoryFreq[cat]   = (categoryFreq[cat]   ?? 0) + 1;
  }

  const threshold = Math.max(2, Math.floor(ignored.length * 0.3));
  const avoids: string[] = [];

  for (const [color, count] of Object.entries(colorFreq)) {
    if (count >= threshold) avoids.push(`${color} colors`);
  }
  for (const [brand, count] of Object.entries(brandFreq)) {
    if (count >= threshold) avoids.push(`${brand} brand`);
  }
  // Category avoids only if very strong signal (user ignored ≥50% of a category)
  for (const [cat, count] of Object.entries(categoryFreq)) {
    if (count >= Math.floor(ignored.length * 0.5)) avoids.push(`${cat} styles`);
  }

  return avoids;
}

// ── Style centroid (cross-session preference vector) ─────────────────────────
// Stores the average CLIP embedding of all products the user has positively
// engaged with across sessions. Used to nudge Pinecone queries toward their
// established personal taste before they even input anything.
//
// Requires a `user_taste_centroids` table:
//   user_token TEXT PRIMARY KEY, centroid JSONB, updated_at TIMESTAMPTZ
// Fails silently if the table does not yet exist.

export async function saveStyleCentroid(
  userToken: string,
  centroid:  number[]
): Promise<void> {
  try {
    const sb = getServiceSupabase();
    await sb.from("user_taste_centroids").upsert(
      { user_token: userToken, centroid, updated_at: new Date().toISOString() },
      { onConflict: "user_token" }
    );
  } catch {
    // Table may not exist yet — fail silently
  }
}

export async function getStyleCentroid(userToken: string): Promise<number[] | null> {
  try {
    const sb = getServiceSupabase();
    const { data } = await sb
      .from("user_taste_centroids")
      .select("centroid")
      .eq("user_token", userToken)
      .single();
    return (data?.centroid as number[] | null) ?? null;
  } catch {
    return null;
  }
}

// ── Full taste memory fetch ───────────────────────────────────────────────────
// Single call that returns everything the pipeline needs for a given user.

export async function loadTasteMemory(userToken: string): Promise<TasteMemory> {
  if (!userToken || userToken === "anon") {
    return { previousDNAs: [], clickSignals: [], softAvoids: [], styleCentroid: null };
  }

  const [previousDNARows, clickSignals, softAvoids, styleCentroid] = await Promise.all([
    getPreviousStyleDNAs(userToken, 5),
    getClickSignals(userToken, 15),
    computeSoftAvoids(userToken),
    getStyleCentroid(userToken),
  ]);

  return {
    previousDNAs: previousDNARows.map((r) => ({ ...r.dna, _boardName: r.board_name } as StyleDNA)),
    clickSignals,
    softAvoids,
    styleCentroid,
  };
}

// ── Training-data fetcher ─────────────────────────────────────────────────────
// Pulls per-user (likes, impressions, dwell) straight from the existing
// Supabase tables for scripts/train-taste-head.mjs to turn into triplets.
// Returns the last N most-active users so we're not sweeping cold accounts
// every training run.

export interface UserSignalBundle {
  user_token:     string;
  liked_ids:      string[];
  impressed_ids:  string[];     // impressed but NOT liked (the skip set)
  fast_swipe_ids: string[];     // subset of impressed: dwell_ms < threshold → strong negative
}

/**
 * Active users (recent likes or impressions) with their signal bundles.
 *
 * @param maxUsers             cap users returned
 * @param maxSignalsPerUser    cap liked / impressed / fast_swipe each
 * @param fastSwipeThresholdMs dwell below this = "fast-swiped" (strong negative).
 *                             Defaults to 500ms — tuned on the shop scroll view:
 *                             anything under half a second is a skim, not
 *                             meaningful impression time.
 */
export async function fetchUserSignalBundles(
  maxUsers             = 200,
  maxSignalsPerUser    = 100,
  fastSwipeThresholdMs = 500,
): Promise<UserSignalBundle[]> {
  const sb = getServiceSupabase();

  // 1. Get the most recent likers (proxy for "active users").
  const { data: recentLikes } = await sb
    .from("taste_signals")
    .select("user_token, clicked_at")
    .order("clicked_at", { ascending: false })
    .limit(maxUsers * 20); // generous — we'll dedup then cap

  const userTokens: string[] = [];
  const seen = new Set<string>();
  for (const row of recentLikes ?? []) {
    const t = (row as { user_token: string }).user_token;
    if (!t || seen.has(t)) continue;
    seen.add(t);
    userTokens.push(t);
    if (userTokens.length >= maxUsers) break;
  }
  if (userTokens.length === 0) return [];

  // 2. For each user, pull their liked object_ids and impressed rows in
  //    parallel. We keep the call count bounded — one likes-query and one
  //    impressions-query per user. With maxUsers=200 that's 400 round
  //    trips, fine inside a CI job but not worth chunking further.
  const out: UserSignalBundle[] = [];
  await Promise.all(userTokens.map(async (user_token) => {
    const [likedRes, imprRes] = await Promise.all([
      sb.from("taste_signals")
        .select("object_id, clicked_at")
        .eq("user_token", user_token)
        .order("clicked_at", { ascending: false })
        .limit(maxSignalsPerUser),
      sb.from("product_impressions")
        .select("object_id, dwell_ms, id")
        .eq("user_token", user_token)
        .order("id", { ascending: false })
        .limit(maxSignalsPerUser * 3), // more impressions than likes, typically
    ]);

    const likedIds = new Set<string>();
    for (const r of (likedRes.data ?? []) as Array<{ object_id: string }>) {
      if (r.object_id) likedIds.add(r.object_id);
    }

    const impressed:  string[] = [];
    const fastSwipe:  string[] = [];
    for (const r of (imprRes.data ?? []) as Array<{ object_id: string; dwell_ms: number | null }>) {
      if (!r.object_id || likedIds.has(r.object_id)) continue;
      if (impressed.length >= maxSignalsPerUser) break;
      impressed.push(r.object_id);
      if (typeof r.dwell_ms === "number" && r.dwell_ms < fastSwipeThresholdMs) {
        fastSwipe.push(r.object_id);
      }
    }

    if (likedIds.size >= 2 && impressed.length >= 1) {
      out.push({
        user_token,
        liked_ids:      Array.from(likedIds),
        impressed_ids:  impressed,
        fast_swipe_ids: fastSwipe,
      });
    }
  }));

  return out;
}
