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
