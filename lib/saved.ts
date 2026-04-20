"use client";

/**
 * Saved products — client-side persistence in localStorage.
 *
 * MVP: single anonymous bucket per browser. Later this moves server-side
 * keyed by user id so saves follow you across devices. The shape we store
 * is deliberately self-contained (full product fields, not just IDs) so
 * /edit can render the grid without re-hitting Algolia for every tile.
 */

const KEY = "muse_saved_products";

export interface SavedProduct {
  objectID:    string;
  title:       string;
  brand:       string;
  retailer?:   string;
  price:       number | null;
  image_url:   string;
  product_url: string;
  category?:   string;
  color?:      string;
  price_range?: string;
  savedAt:     number;  // epoch ms for sort-by-recent
}

export function readSaved(): SavedProduct[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedProduct[]) : [];
  } catch {
    return [];
  }
}

export function writeSaved(items: SavedProduct[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // localStorage can throw in private-browsing or quota-exceeded cases.
    // Swallow — saving is a nice-to-have, not worth tearing down the UI.
  }
}

export function addSaved(p: Omit<SavedProduct, "savedAt">): SavedProduct[] {
  const current = readSaved();
  if (current.some((x) => x.objectID === p.objectID)) return current;
  const next = [{ ...p, savedAt: Date.now() }, ...current];
  writeSaved(next);
  return next;
}

export function removeSaved(objectID: string): SavedProduct[] {
  const current = readSaved();
  const next    = current.filter((x) => x.objectID !== objectID);
  writeSaved(next);
  return next;
}

export function isSaved(objectID: string): boolean {
  return readSaved().some((x) => x.objectID === objectID);
}

// ── Shortlist-as-preference signal ───────────────────────────────────────────
//
// Saved products are durable, deliberate "I want more of this" signals — a
// stronger statement than an in-session like, and persistent across visits.
// The helpers below expose the shortlist as inputs to the existing
// bias/ranking pipelines so a populated shortlist nudges every subsequent
// product surface toward the user's curated taste without replacing the
// session signal that reacts to what they're doing right now.
//
// The shop feed merges these with the click-history counts in buildBias; the
// dashboard uses the text summary as extra context fed to Claude during the
// aesthetic step.

interface ShortlistSignal {
  objectID:     string;
  category?:    string;
  brand?:       string;
  color?:       string;
  price_range?: string;
  retailer?:    string;
}

/**
 * Return the shortlist as an array of like-signal records, shaped to match
 * ClickSignalLike so callers can concat with session click-history and run
 * their existing byKey tallies unchanged. Empty array when nothing is saved.
 */
export function getShortlistSignals(): ShortlistSignal[] {
  return readSaved().map((p) => ({
    objectID:    p.objectID,
    category:    p.category,
    brand:       p.brand,
    color:       p.color,
    price_range: p.price_range,
    retailer:    p.retailer,
  }));
}

/**
 * One-line, human-readable summary of the shortlist for prompt injection.
 * Returns null when the shortlist is empty so callers can branch cleanly
 * ("only attach this if the user has a shortlist").
 *
 * Format leans informational rather than imperative — Claude should read this
 * as "this user has historically saved these kinds of things" rather than
 * "these are filters to apply," so the influence stays marginal.
 */
export function getShortlistSummary(max = { brands: 5, categories: 4, colors: 3 }): string | null {
  const items = readSaved();
  if (items.length === 0) return null;

  const topN = <K extends keyof SavedProduct>(key: K, n: number): Array<[string, number]> => {
    const counts = new Map<string, number>();
    for (const it of items) {
      const v = String(it[key] ?? "").trim();
      if (!v) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  };

  const brands     = topN("brand",    max.brands);
  const categories = topN("category", max.categories);
  const colors     = topN("color",    max.colors);

  const fmt = (pairs: Array<[string, number]>) =>
    pairs.map(([v, n]) => (n > 1 ? `${v} (${n})` : v)).join(", ");

  const parts: string[] = [];
  if (brands.length)     parts.push(`brands: ${fmt(brands)}`);
  if (categories.length) parts.push(`categories: ${fmt(categories)}`);
  if (colors.length)     parts.push(`colors: ${fmt(colors)}`);

  if (parts.length === 0) return null;
  return `The user has previously saved ${items.length} item${items.length === 1 ? "" : "s"} to their shortlist — ${parts.join("; ")}. Treat this as a gentle preference signal, not a hard filter.`;
}
