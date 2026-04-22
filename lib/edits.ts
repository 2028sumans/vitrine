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
