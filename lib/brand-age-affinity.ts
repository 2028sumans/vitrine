/**
 * Brand → preferred-age affinity layer.
 *
 * The catalog's FashionCLIP vectors are visual-only — they don't encode "who
 * actually wears this brand." Sometimes a brand's product images score high
 * on similarity to a demographic centroid that's a poor fit (e.g., Dhruv
 * Kapoor's distressed-denim aesthetic landing near the 13-18 centroid even
 * though the brand's natural buyer skews 25-32+).
 *
 * This module provides a per-brand override for those cases. When a user's
 * age range isn't in a brand's preferredAges list, we soft-demote that
 * brand's products in ranking — they stay visible (no blacklist), just
 * pushed toward the end so they don't crowd out better-matched items at
 * the top.
 *
 * Curated by hand; loaded from lib/brand-age-affinity.json so adjustments
 * don't require a code change.
 */

import affinityFile from "@/lib/brand-age-affinity.json";
import type { AgeRangeKey } from "@/lib/onboarding-memory";

interface AffinityFile {
  version: number;
  biases:  Record<string, { preferredAges: string[] }>;
}

const AFFINITY: AffinityFile = affinityFile as unknown as AffinityFile;

/**
 * Normalise a brand string for lookup. Lowercase, collapse whitespace, trim.
 * Matches "Dhruv Kapoor" / "dhruv kapoor" / "DHRUV  KAPOOR" identically.
 */
function normalize(brand: string): string {
  return brand.toLowerCase().replace(/\s+/g, " ").trim();
}

// Pre-build a lookup map keyed on normalised brand. Done at module load
// so the per-product check in the hot path is a single Map.get().
const BIAS_MAP: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const [brand, cfg] of Object.entries(AFFINITY.biases ?? {})) {
    if (!cfg?.preferredAges?.length) continue;
    m.set(normalize(brand), new Set(cfg.preferredAges));
  }
  return m;
})();

/**
 * Return whether the given product matches the user's age affinity.
 *   - true   = match (or no preference set for this brand) → no penalty
 *   - false  = brand has preferences and user's age isn't in them → demote
 *
 * Both `brand` and `retailer` are checked because the catalog uses either
 * depending on the source. First match wins.
 */
export function matchesAgeAffinity(
  brand:    string | undefined | null,
  retailer: string | undefined | null,
  userAge:  AgeRangeKey | null,
): boolean {
  if (!userAge) return true;  // No user age → no signal to apply
  for (const candidate of [brand, retailer]) {
    if (!candidate) continue;
    const set = BIAS_MAP.get(normalize(candidate));
    if (set) return set.has(userAge);
  }
  return true;  // Brand has no entry in the config → neutral
}

/**
 * Demote products whose brand has a preferred-age mismatch with the user's
 * age. Mismatched products move to the end of the list, keeping their
 * relative order; matched / neutral products stay where they were.
 *
 * Pure function — caller passes products + user age, gets a new array back.
 */
export function applyBrandAgePenalty<T extends { brand?: string; retailer?: string }>(
  products: T[],
  userAge:  AgeRangeKey | null,
): T[] {
  if (!userAge || products.length === 0) return products;
  const matched:    T[] = [];
  const mismatched: T[] = [];
  for (const p of products) {
    if (matchesAgeAffinity(p.brand, p.retailer, userAge)) matched.push(p);
    else                                                    mismatched.push(p);
  }
  // Trivial all-match short-circuit avoids allocating a new array.
  if (mismatched.length === 0) return products;
  return [...matched, ...mismatched];
}

/**
 * Multiplicative score adjustment for ranking pipelines that work with raw
 * cosine scores rather than ordered arrays (e.g., /api/brands/ordered).
 * Returns 1.0 for matches, `penalty` for mismatches.
 */
export function ageAffinityMultiplier(
  brand:    string | undefined | null,
  retailer: string | undefined | null,
  userAge:  AgeRangeKey | null,
  penalty   = 0.5,
): number {
  return matchesAgeAffinity(brand, retailer, userAge) ? 1.0 : penalty;
}
