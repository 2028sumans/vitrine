/**
 * GET /api/brands/ordered?userToken=<token>
 *
 * Returns the brand list sorted by cosine-similarity of each brand's
 * FashionCLIP centroid to the requesting user's taste vector. Used by the
 * /brands page to reorder its static alphabetical grid for signed-in users
 * whose onboarding centroid is available.
 *
 * Response shape
 * --------------
 *   { brands: string[], ordered: boolean }
 *
 *   brands   — exhaustive list of brand names in sort order. The /brands
 *              page reorders its own static brands.json data against this
 *              array, so we don't repeat name / imageUrl / count here.
 *   ordered  — false if we couldn't compose a taste vector (anon user,
 *              onboarding skipped without any session signal, brand-
 *              centroids file missing). Caller should fall back to its
 *              alphabetical default.
 *
 * Performance
 * -----------
 *   brand-centroids.json is ~2.5 MB in memory (~240 brands × 512 floats).
 *   Next.js caches the module import so only the first request pays the
 *   load cost. The cosine loop is 240 × 512 = 122k multiplies, runs in
 *   single-digit ms.
 */

import { NextResponse } from "next/server";
import { loadUserTasteVector } from "@/lib/taste-profile";
import { ageAffinityMultiplier } from "@/lib/brand-age-affinity";
// Eager import — the file is built artefact JSON, not user data. Module
// resolution happens once per server boot.
import brandCentroids from "@/lib/brand-centroids.json";

interface BrandCentroidsFile {
  version:      number;
  dim:          number;
  builtAt:      string;
  sampleCounts: Record<string, number>;
  centroids:    Record<string, number[] | null>;
}

const BRANDS: BrandCentroidsFile = brandCentroids as unknown as BrandCentroidsFile;

// Dot product of two equal-length arrays. Both inputs are expected to be
// unit-length (the builder scripts normalize), so this IS cosine similarity.
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export async function GET(request: Request) {
  const url       = new URL(request.url);
  const userToken = (url.searchParams.get("userToken") ?? "").trim();

  // No brand centroids file means the builder hasn't run yet. Return empty
  // so the client falls back to alphabetical — better than a 500.
  const centroids = BRANDS?.centroids;
  if (!centroids || Object.keys(centroids).length === 0) {
    return NextResponse.json({ brands: [], ordered: false });
  }

  const allBrands = Object.keys(centroids);
  if (!userToken || userToken === "anon") {
    return NextResponse.json({ brands: allBrands.sort((a, b) => a.localeCompare(b)), ordered: false });
  }

  let profile;
  try {
    profile = await loadUserTasteVector(userToken);
  } catch {
    return NextResponse.json({ brands: allBrands.sort((a, b) => a.localeCompare(b)), ordered: false });
  }
  const taste   = profile.vector;
  const userAge = profile.sources.age;

  // No composable vector — anon effectively. Alphabetical, signal the
  // caller so it doesn't render a "sorted for you" affordance.
  if (!taste || taste.length === 0) {
    return NextResponse.json({ brands: allBrands.sort((a, b) => a.localeCompare(b)), ordered: false });
  }

  // Score each brand. Brands with no centroid (empty sample) get -Infinity
  // so they end up at the end, where the /brands UI will render them after
  // the taste-ranked run.
  //
  // The brand-age affinity multiplier (lib/brand-age-affinity) gates score
  // against the user's age. Brands with a curated mismatch get their score
  // halved — still scored, still ordered, just demoted relative to matched
  // brands. Brands with no entry in the config are neutral (multiplier 1).
  const scored = allBrands.map((brand) => {
    const v = centroids[brand];
    const raw = v && v.length === taste.length ? cosine(taste, v) : -Infinity;
    const adjusted = raw === -Infinity ? raw : raw * ageAffinityMultiplier(brand, null, userAge);
    return { brand, score: adjusted };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.brand.localeCompare(b.brand);
  });

  return NextResponse.json({
    brands:  scored.map((s) => s.brand),
    ordered: true,
    // Expose top scores for debugging; cheap and handy in dev tools.
    top:     scored.slice(0, 5).map((s) => ({ brand: s.brand, score: Number(s.score.toFixed(4)) })),
  });
}
