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

// ── Board → StyleDNA read cache ───────────────────────────────────────────────
// Pinterest boards rarely change materially inside a day. When the same user
// re-analyzes the same board, we skip the Sonnet-vision + Haiku-synthesis
// phase entirely — typically the largest chunk of the "Finding your picks"
// loading screen (~2–3 s saved).
//
// TTL: 24 hours. Long enough to make repeat visits feel instant, short
// enough that the user can force a refresh by waiting a day. For now, the
// only invalidation path is the TTL; future work can wire a manual refresh
// button.
const STYLE_DNA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function getStyleDNAByBoard(
  userToken: string,
  boardId:   string
): Promise<{ dna: StyleDNA; created_at: string } | null> {
  if (!userToken || !boardId) return null;
  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from("user_style_dnas")
    .select("style_dna, created_at")
    .eq("user_token", userToken)
    .eq("board_id",   boardId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data || !data.style_dna) return null;

  const createdAt = typeof data.created_at === "string" ? data.created_at : "";
  const ageMs     = createdAt ? Date.now() - new Date(createdAt).getTime() : Infinity;
  if (!Number.isFinite(ageMs) || ageMs > STYLE_DNA_CACHE_TTL_MS) return null;

  return { dna: data.style_dna as StyleDNA, created_at: createdAt };
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
    }))
  );
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

