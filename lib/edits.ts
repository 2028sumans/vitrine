/**
 * Curated edits — hand-picked themed product lists, seeded by scripts/curate-edits.mjs
 * and hand-edited in content/edits.json.
 *
 * This module is intentionally client-safe — no Algolia or other server-only
 * deps — so the homepage (a client component) can read the edit list cheaply.
 * Server-side product hydration lives in app/edits/[slug]/page.tsx.
 *
 * When the team wants a non-engineer publishing workflow, migrate this file
 * to read from a `curated_edits` Supabase table.
 */
import editsJson from "@/content/edits.json";

export interface Edit {
  slug:                 string;
  title:                string;
  subtitle:             string;
  hero_image_url:       string | null;
  product_ids:          string[];
  featured_on_homepage: boolean;
  published_at:         string;
  // Optional tail-page filter forwarded to /api/shop-all when the infinite
  // scroll fetches beyond the curated set. Without this, a focused edit
  // (e.g. "Swimwear") relies on soft steer keywords alone and the tail
  // can drift into off-brief brands (cashmere knits, denim, etc.). Any
  // field here is optional — specify only what tightens the brief.
  //
  //   categoryFilter — one of the /api/shop-all category labels:
  //     "Tops" | "Dresses" | "Bottoms" | "Shoes" | "Outerwear" |
  //     "Bags and accessories" | "Knits" | "Other"
  //   priceMax       — numeric USD cap (null = no cap)
  //   brandFilter    — single brand name, for brand-scoped edits
  filter?: {
    categoryFilter?: string;
    priceMax?:       number | null;
    brandFilter?:    string;
  };
}

// All edits, in authored order. Cast at the boundary — the JSON is trusted.
const ALL: Edit[] = editsJson as Edit[];

export function listEdits(): Edit[] {
  return ALL;
}

export function listFeaturedEdits(): Edit[] {
  return ALL.filter((e) => e.featured_on_homepage);
}

export function getEditBySlug(slug: string): Edit | null {
  return ALL.find((e) => e.slug === slug) ?? null;
}
