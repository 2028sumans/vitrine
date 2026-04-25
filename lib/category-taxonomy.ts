/**
 * Canonical category taxonomy for the per-category golden datasets.
 *
 * Used by:
 *   - /admin/label index + /admin/label/[category]   (which categories exist, how to label them)
 *   - scripts/build-eval-triplets.mjs                (what files to produce)
 *   - scripts/build-age-centroids.mjs                (per-category centroid output)
 *   - lib/taste-profile.ts                            (which centroid set to consume)
 *
 * Three keys per row:
 *   slug    — URL-safe identifier. Stable. Used in localStorage keys, file
 *             names, and the per-category route path.
 *   label   — display name for the UI. Free to change without consequence.
 *   filter  — exact value to send as `categoryFilter` to /api/shop-all. Must
 *             match one of the cases in scopeForCategory() in the route.
 *
 * Adding a category: add a row here, label items at /admin/label/<slug>,
 * download, run the two build scripts. The taste pipeline picks it up
 * automatically — no other code changes required.
 */

export interface CategoryRow {
  slug:   string;
  label:  string;
  filter: string;
}

export const CATEGORIES: ReadonlyArray<CategoryRow> = [
  { slug: "tops",                 label: "Tops",                  filter: "Tops" },
  { slug: "dresses",              label: "Dresses",               filter: "Dresses" },
  { slug: "bottoms",              label: "Bottoms",               filter: "Bottoms" },
  { slug: "knits",                label: "Knits",                 filter: "Knits" },
  { slug: "outerwear",            label: "Outerwear",             filter: "Outerwear" },
  { slug: "shoes",                label: "Shoes",                 filter: "Shoes" },
  { slug: "bags-and-accessories", label: "Bags & Accessories",    filter: "Bags and accessories" },
];

/** Lookup helper — returns the canonical row for a slug, or null. */
export function categoryFromSlug(slug: string): CategoryRow | null {
  return CATEGORIES.find((c) => c.slug === slug) ?? null;
}

/** Reverse lookup — given a display-style filter string ("Tops",
 *  "Bags and accessories"), return the canonical slug ("tops",
 *  "bags-and-accessories") or null. Case-insensitive. Used by /api/shop-all
 *  to translate the inbound `categoryFilter` into the slug that taste-profile
 *  uses to look up per-category centroids. */
export function slugFromFilter(filter: string | null | undefined): string | null {
  if (!filter) return null;
  const f = filter.toLowerCase().trim();
  return CATEGORIES.find((c) => c.filter.toLowerCase() === f)?.slug ?? null;
}

/** All slugs as a typed tuple for switch-statement exhaustiveness checks. */
export const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug) as readonly string[];
