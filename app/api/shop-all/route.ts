/**
 * POST /api/shop-all
 *
 * Paginated catalog listing for /shop. Three lanes:
 *
 *   (a) No filter, no signals — 8-slice catalog walk: fires 8 parallel Algolia
 *       queries at evenly-spaced offsets across the catalog and round-robin
 *       interleaves the hits so a single 48-product page mixes 8 different
 *       brand clusters instead of 48 consecutive items from one brand.
 *       (Currently unreachable from /shop since the UI always sends a filter,
 *       but retained for /shop-all sanity / future flat views.)
 *
 *   (b) Brand or category filter — hard-scope to that lens. Paginated walk
 *       within the scope. Bias/Steer signals still rank-boost within the
 *       scope but don't trim it.
 *
 *   (c) Session signals without scope (likes/dislikes from the session) —
 *       query-driven taste search across the whole catalog.
 */

import { NextResponse }  from "next/server";
import { algoliasearch } from "algoliasearch";
import { searchByEmbeddings, searchByLikedProductIds } from "@/lib/embeddings";
import { loadUserTasteVector } from "@/lib/taste-profile";
import { applyBrandAgePenalty } from "@/lib/brand-age-affinity";
import { slugFromFilter } from "@/lib/category-taxonomy";
import type { AgeRangeKey } from "@/lib/onboarding-memory";

export const revalidate = 60;

const INDEX_NAME    = "vitrine_products";
const HITS_PER_PAGE = 48;
// Over-fetch in scoped mode so the diversifier has a wide enough pool to
// mix across aesthetic × brand axes. Without this, Algolia's default
// ranking clumps a single brand/aesthetic. 8x gives the mixer enough
// inventory from 12+ aesthetic buckets to emit a genuinely varied feed —
// faster preference elicitation as the user scrolls and likes things.
const SCOPED_FETCH   = HITS_PER_PAGE * 8;

// ── Category scopes ──────────────────────────────────────────────────────────
// Display label → Algolia scope. The catalog's `category` field holds one of
// six values (dress/top/bottom/jacket/shoes/bag). The display lanes expose
// more granular labels; we map them to category filters plus an optional
// keyword query. Knits is a cross-category keyword search because the catalog
// has no knit attribute yet. Other is the residual of anything uncategorised.

const CORE_CATS = ["dress", "top", "bottom", "jacket", "shoes", "bag"] as const;

type CategoryScope = {
  /** Algolia `filters` expression, or null for no filter. */
  filters: string | null;
  /** Words injected into the Algolia `query` (with optionalWords ranking). */
  keywords: string[];
  /**
   * Strict check run as a post-filter on the Algolia hits. Belt-and-braces
   * guard against mis-tagged catalog rows (e.g. a hoodie with category="shoes"
   * slipping into the Shoes lane because the Algolia filter matched).
   * Return true to keep a product, false to drop it.
   */
  enforce?: (p: Record<string, unknown>) => boolean;
};

// Title-keyword blocklist per display category — words whose presence in
// a title strongly contradicts the category, even if the Algolia `category`
// tag claims otherwise. Catches mis-tagged rows without requiring a positive
// keyword match (which would over-filter legitimately-named pieces like
// "Belle Strapless" in Tops).
//
// Matched with word-start boundaries so "heel" won't hit "loopwheel".
const CATEGORY_BLOCKERS: Record<string, readonly string[]> = {
  tops:       ["shoe", "boot", "sandal", "heel", "sneaker", "loafer", "pump", "pant", "skirt", "dress", "jean", "trouser", "bag", "tote", "handbag", "clutch"],
  dresses:    ["shoe", "boot", "sandal", "heel", "sneaker", "loafer", "pump", "pant", "jean", "trouser", "bag", "tote", "handbag", "clutch", "jacket", "coat", "blazer"],
  bottoms:    ["shoe", "boot", "sandal", "heel", "sneaker", "loafer", "pump", "dress", "shirt", "blouse", "top", "tee", "tank", "jacket", "coat", "blazer", "bag", "tote", "handbag", "clutch"],
  shoes:      ["hoody", "hoodie", "sweater", "sweatshirt", "cardigan", "jumper", "shirt", "blouse", "tee", "tank", "dress", "gown", "pant", "skirt", "short", "jean", "trouser", "jacket", "coat", "blazer", "bag", "tote", "handbag", "clutch", "necklace", "bracelet", "ring", "earring", "belt"],
  outerwear:  ["shoe", "boot", "sandal", "heel", "sneaker", "loafer", "pump", "dress", "gown", "skirt", "short", "jean", "trouser", "bag", "tote", "handbag", "clutch"],
  "bags and accessories": ["shoe", "boot", "sandal", "heel", "sneaker", "pant", "skirt", "dress", "shirt", "blouse", "jacket", "coat"],
};

function passesCategoryBlocker(p: Record<string, unknown>, bucket: string): boolean {
  const blockers = CATEGORY_BLOCKERS[bucket];
  if (!blockers) return true;
  const title = String(p.title ?? "").toLowerCase();
  return !blockers.some((k) => new RegExp(`\\b${k}`, "i").test(title));
}

function scopeForCategory(label: string): CategoryScope | null {
  const key = label.toLowerCase().trim();
  switch (key) {
    case "tops":                 return { filters: 'category:"top"',    keywords: [], enforce: (p) => passesCategoryBlocker(p, "tops") };
    case "dresses":              return { filters: 'category:"dress"',  keywords: [], enforce: (p) => passesCategoryBlocker(p, "dresses") };
    case "bottoms":              return { filters: 'category:"bottom"', keywords: [], enforce: (p) => passesCategoryBlocker(p, "bottoms") };
    case "shoes":                return { filters: 'category:"shoes"',  keywords: [], enforce: (p) => passesCategoryBlocker(p, "shoes") };
    case "outerwear":            return { filters: 'category:"jacket"', keywords: [], enforce: (p) => passesCategoryBlocker(p, "outerwear") };
    case "bags and accessories": return { filters: 'category:"bag"',    keywords: [], enforce: (p) => passesCategoryBlocker(p, "bags and accessories") };
    case "knits": {
      // Knits IS keyword-driven, not a mis-tag guard — Algolia has no knit
      // category, so we keyword-search and require at least one positive
      // hit in the title so leggings/jeans/etc. don't leak in.
      const knitHints = ["knit", "sweater", "cardigan", "cashmere", "wool", "cable", "jumper", "pullover", "turtleneck"];
      return {
        filters:  null,
        keywords: ["knit", "sweater", "cardigan", "cashmere", "wool"],
        enforce:  (p) => {
          const title = String(p.title ?? "").toLowerCase();
          return knitHints.some((k) => new RegExp(`\\b${k}`, "i").test(title));
        },
      };
    }
    case "other": {
      const parts = CORE_CATS.map((c) => `NOT category:"${c}"`);
      return {
        filters:  parts.join(" AND "),
        keywords: [],
        enforce:  (p) => {
          const pc = String(p.category ?? "").toLowerCase().trim();
          return !pc || !CORE_CATS.includes(pc as typeof CORE_CATS[number]);
        },
      };
    }
    default: return null;
  }
}

// Round-robin by brand so a single batch doesn't clump a brand's entire
// inventory together. Group by brand (case-insensitive, falling back to
// retailer), then take one from each bucket in order until all are drained.
// Preserves Algolia's per-brand internal ranking while spreading brands out.
function interleaveByBrand<T extends Record<string, unknown>>(products: T[]): T[] {
  const byBrand = new Map<string, T[]>();
  for (const p of products) {
    const key = String(p.brand ?? p.retailer ?? "").toLowerCase().trim() || "__unknown__";
    const bucket = byBrand.get(key);
    if (bucket) bucket.push(p);
    else byBrand.set(key, [p]);
  }
  const buckets = Array.from(byBrand.values());
  const out: T[] = [];
  let anyLeft = true;
  while (anyLeft) {
    anyLeft = false;
    for (const bucket of buckets) {
      const p = bucket.shift();
      if (p !== undefined) {
        out.push(p);
        anyLeft = true;
      }
    }
  }
  return out;
}

/**
 * Spread items so the same brand never appears within `cooldown` slots of
 * itself — when possible. When one brand dominates the remaining pool
 * (common on category pages where a few labels have hundreds of items each)
 * the classic nested round-robin eventually drains smaller brands and
 * leaves a long mono-brand tail. This pass uses the "task scheduler"
 * greedy: always emit from the brand with the most remaining items that
 * isn't on cooldown; when every eligible brand is on cooldown, take the
 * first one off cooldown (keeps the output length = input length, never
 * drops items).
 *
 * O(n × b) where b = number of distinct brands — trivial for n ≤ 500 and
 * b ≤ 50, which is the realistic shape of a scoped page.
 *
 * cooldown = 4 empirically gave max same-brand run == 1 on a Tops page
 * dominated by 4 brands with 50+ items each (previously max-run = 4 at
 * the tail as smaller brands drained).
 */
function spreadByBrand<T extends Record<string, unknown>>(
  products: T[],
  cooldown = 4,
): T[] {
  if (products.length <= 1) return products;

  const byBrand = new Map<string, T[]>();
  for (const p of products) {
    const k = pickBrandKey(p);
    const bucket = byBrand.get(k);
    if (bucket) bucket.push(p);
    else byBrand.set(k, [p]);
  }

  const out:       T[]       = [];
  const cooldownQ: string[]  = []; // FIFO of recently-emitted brands

  while (out.length < products.length) {
    // Best = brand with most remaining items, NOT in cooldownQ.
    let bestBrand: string | null = null;
    let bestCount  = 0;
    for (const [brand, list] of Array.from(byBrand.entries())) {
      if (list.length === 0) continue;
      if (cooldownQ.includes(brand)) continue;
      if (list.length > bestCount) {
        bestBrand = brand;
        bestCount = list.length;
      }
    }

    // Every remaining brand is on cooldown — release the oldest that still
    // has items. Guarantees forward progress; no items ever get dropped.
    if (!bestBrand) {
      for (const b of cooldownQ) {
        const list = byBrand.get(b);
        if (list && list.length > 0) { bestBrand = b; break; }
      }
    }
    if (!bestBrand) break; // unreachable given the invariants, defensive.

    out.push(byBrand.get(bestBrand)!.shift()!);

    // Refresh cooldown queue.
    const prev = cooldownQ.indexOf(bestBrand);
    if (prev !== -1) cooldownQ.splice(prev, 1);
    cooldownQ.push(bestBrand);
    if (cooldownQ.length > cooldown) cooldownQ.shift();
  }

  return out;
}

// Aesthetic buckets mirror the AESTHETIC_MAP keys in scripts/upload-to-algolia.mjs.
// Anything not matching one of these lands in the __unknown__ bucket.
const KNOWN_AESTHETICS = new Set([
  "minimalist", "bohemian", "romantic", "edgy", "preppy", "casual",
  "elegant", "sporty", "cottagecore", "party", "y2k", "coastal",
]);

function pickAesthetic(p: Record<string, unknown>): string {
  const tags = Array.isArray(p.aesthetic_tags) ? p.aesthetic_tags : [];
  for (const t of tags) {
    const s = String(t).toLowerCase();
    if (KNOWN_AESTHETICS.has(s)) return s;
  }
  return "__unknown__";
}

function pickBrandKey(p: Record<string, unknown>): string {
  return String(p.brand ?? p.retailer ?? "").toLowerCase().trim() || "__unknown__";
}

// Nested round-robin: outer by aesthetic, inner by brand. Each pass emits one
// item from each aesthetic bucket (rotating brands inside), so the first N
// products span as many style dimensions as the pool allows. This gives the
// scroll feed a genuinely varied seed — a liked item narrows across multiple
// axes at once instead of just reinforcing whichever aesthetic we happened
// to land on first.
function interleaveByAestheticAndBrand<T extends Record<string, unknown>>(products: T[]): T[] {
  const byAesthetic = new Map<string, Map<string, T[]>>();
  for (const p of products) {
    const a = pickAesthetic(p);
    const b = pickBrandKey(p);
    let brandMap = byAesthetic.get(a);
    if (!brandMap) { brandMap = new Map(); byAesthetic.set(a, brandMap); }
    const bucket = brandMap.get(b);
    if (bucket) bucket.push(p);
    else brandMap.set(b, [p]);
  }

  // Flatten each aesthetic's products via inner brand round-robin.
  const aestheticQueues: T[][] = [];
  for (const brandMap of Array.from(byAesthetic.values())) {
    const brandBuckets: T[][] = Array.from(brandMap.values());
    const queue: T[] = [];
    let anyLeft = true;
    while (anyLeft) {
      anyLeft = false;
      for (const bucket of brandBuckets) {
        const item = bucket.shift();
        if (item !== undefined) { queue.push(item); anyLeft = true; }
      }
    }
    aestheticQueues.push(queue);
  }

  // Outer round-robin across aesthetic queues.
  const out: T[] = [];
  let anyLeft = true;
  while (anyLeft) {
    anyLeft = false;
    for (const q of aestheticQueues) {
      const item = q.shift();
      if (item !== undefined) { out.push(item); anyLeft = true; }
    }
  }
  return out;
}

interface BiasPayload {
  likedBrands?:         string[];
  likedCategories?:     string[];
  likedColors?:         string[];
  dislikedBrands?:      string[];
  dislikedCategories?:  string[];
}

// ── FashionCLIP similarity boost ──────────────────────────────────────────────
// Given the objectIDs of products the user has liked, we query Pinecone for
// the top-K most visually-similar products (averaging the liked vectors as a
// centroid). Those hits bubble to the front of whatever Algolia returns.
// This is the single biggest lever for making the feed feel "smart" — the
// difference between "shows me more from brands I liked" (metadata-bias) and
// "shows me things that LOOK like what I liked" (content similarity).
//
// Fire-and-forget safe: if Pinecone fails, we fall through to Algolia-only.
async function clipSimilarityRanking(likedProductIds: string[]): Promise<string[]> {
  if (likedProductIds.length === 0) return [];
  try {
    // Exclude the liked products themselves from results — the user's already
    // seen them. `totalK = 300` is generous so the boost has plenty of
    // candidates even if Algolia's filtered result set is large.
    return await searchByLikedProductIds(likedProductIds, 300, {}, likedProductIds);
  } catch (e) {
    console.warn("[shop-all] CLIP similarity skipped:", e instanceof Error ? e.message : e);
    return [];
  }
}

// Taste-vector ranking — complementary to the liked-products CLIP boost.
// Pulls the user's unified onboarding vector (age prior + upload centroid +
// session centroid blended per lib/taste-profile.ts) and runs a single
// Pinecone query against it. Returns ordered objectIDs to feed into the
// same boost step as clipIds. Fires for any signed-in user with a non-null
// centroid — no "liked >= 2" floor, because the onboarding centroid is
// itself a deliberately-chosen signal, not accumulated click noise.
async function tasteVectorRanking(
  userToken:    string,
  categorySlug: string | null,
): Promise<{ ids: string[]; hasVector: boolean; userAge: AgeRangeKey | null }> {
  if (!userToken || userToken === "anon") return { ids: [], hasVector: false, userAge: null };
  try {
    // Pass the category slug so loadUserTasteVector picks the per-category
    // age centroid instead of the cross-category average. When unscoped
    // (no slug), it falls back to averaging all populated category centroids
    // for the user's age — sensible default behaviour.
    const profile = await loadUserTasteVector(userToken, { category: categorySlug });
    const userAge = profile.sources.age;
    if (!profile.vector || profile.vector.length === 0) return { ids: [], hasVector: false, userAge };
    const ids = await searchByEmbeddings([profile.vector], 300);
    return { ids, hasVector: true, userAge };
  } catch (e) {
    console.warn("[shop-all] taste-vector ranking skipped:", e instanceof Error ? e.message : e);
    return { ids: [], hasVector: false, userAge: null };
  }
}

// Interleave two ranked-ID lists by lowest-combined-rank. Items appearing
// in both get their ranks averaged (boosted by consensus); items in only
// one keep their original rank. Result is a single sorted list of unique
// IDs preserving rank order of "strongest fusion signal first."
// Used when we have both a liked-products CLIP boost AND a taste-vector
// boost and want one merged boost list for `boostByClipSimilarity`.
function mergeRankedIds(a: string[], b: string[]): string[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const score = new Map<string, number>();
  a.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (i + 1)));
  b.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (i + 1)));
  return Array.from(score.entries())
    .sort((x, y) => y[1] - x[1])
    .map(([id]) => id);
}

// Boost products whose objectID appears in `clipIds` to the front of the
// list, ordered by CLIP rank. Cap at `topN` so the tail keeps Algolia's
// interleaved diversity — we're ordering the lead of the feed, not replacing
// it. Skip the boost entirely when the user has fewer than 2 liked items
// (not enough signal to trust centroid search).
function boostByClipSimilarity<T extends Record<string, unknown>>(
  products:     T[],
  clipIds:      string[],
  likedCount:   number,
  topN = 12,
): T[] {
  if (clipIds.length === 0 || likedCount < 2) return products;
  const rank = new Map<string, number>();
  clipIds.forEach((id, i) => rank.set(id, i));
  const boosted: T[] = [];
  const rest:    T[] = [];
  for (const p of products) {
    const id = typeof p.objectID === "string" ? p.objectID : null;
    if (id && rank.has(id)) boosted.push(p);
    else rest.push(p);
  }
  boosted.sort((a, b) => rank.get(a.objectID as string)! - rank.get(b.objectID as string)!);
  const head = boosted.slice(0, topN);
  const tail = boosted.slice(topN);
  return [...head, ...tail, ...rest];
}

interface SteerInterp {
  search_terms?: string[];
  avoid_terms?:  string[];
  price_range?:  "budget" | "mid" | "luxury" | null;
  categories?:   string[];
  colors?:       string[];
}

function buildQueryFromBias(bias: BiasPayload): string {
  const terms: string[] = [];
  for (const b of bias.likedBrands      ?? []) terms.push(b);
  for (const c of bias.likedCategories  ?? []) terms.push(c);
  for (const c of bias.likedColors      ?? []) terms.push(c);
  return terms.filter(Boolean).join(" ").trim();
}

function hasLikedSignals(bias: BiasPayload): boolean {
  return (bias.likedBrands?.length ?? 0) > 0
      || (bias.likedCategories?.length ?? 0) > 0
      || (bias.likedColors?.length ?? 0) > 0;
}

function hasSteerSignals(s: SteerInterp | null): boolean {
  if (!s) return false;
  return (s.search_terms?.length ?? 0) > 0
      || (s.avoid_terms?.length  ?? 0) > 0
      || !!s.price_range
      || (s.categories?.length   ?? 0) > 0
      || (s.colors?.length       ?? 0) > 0;
}

function buildSteerQuery(s: SteerInterp | null): string {
  if (!s) return "";
  const terms: string[] = [];
  for (const t of s.search_terms ?? []) terms.push(t);
  for (const c of s.colors       ?? []) terms.push(c);
  for (const c of s.categories   ?? []) terms.push(c);
  return terms.filter(Boolean).join(" ").trim();
}

// Fold a max-price cap into an existing Algolia `filters` expression.
// Returns the expression joined by AND, or just the scope filter / just the
// price filter if the other is empty. Used by both the scoped lane (brand /
// category) and the query-driven lane. Algolia accepts numeric comparisons
// like `price <= 250` inside the same `filters` string as facet filters, so
// a single AND-joined expression is all we need.
function composeFilters(scopeFilter: string, priceMax: number | null): string {
  const parts: string[] = [];
  if (scopeFilter) parts.push(scopeFilter);
  if (priceMax != null && priceMax > 0) parts.push(`price <= ${priceMax}`);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  // Parenthesize each piece so complex scope expressions (e.g. the `NOT
  // category:"x" AND NOT category:"y"` used by the "Other" lane) don't
  // get mis-associated when combined with the numeric clause.
  return parts.map((p) => `(${p})`).join(" AND ");
}

// Lenient price-cap post-filter. Algolia's numeric filter already enforces
// the cap on the server, but (a) rows with a missing / null `price` fall
// through Algolia's filter (undefined-facet behavior), so we defensively
// re-check here, and (b) keeping the double-check makes the intent obvious
// when reading the filter chain. Rows without a price survive — we'd rather
// show a price-missing piece than a pair of empty shelves.
function applyPriceMaxPostFilter(
  products: Array<Record<string, unknown>>,
  priceMax: number | null,
): Array<Record<string, unknown>> {
  if (priceMax == null || priceMax <= 0) return products;
  return products.filter((p) => {
    const raw = p.price;
    if (raw == null) return true;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return true;
    return n <= priceMax;
  });
}

// Apply the semantic pieces of a SteerInterp (price_range, categories,
// colors, avoid_terms) as a lenient post-filter. Lenient means: only drops
// a product if it HAS the field and the field disagrees — products missing
// the field are kept so we don't nuke the whole feed over incomplete data.
function applySteerPostFilter(
  products: Array<Record<string, unknown>>,
  s: SteerInterp | null,
): Array<Record<string, unknown>> {
  if (!s) return products;
  const priceRange = s.price_range;
  const cats       = (s.categories ?? []).map((c) => c.toLowerCase().trim()).filter(Boolean);
  const cols       = (s.colors     ?? []).map((c) => c.toLowerCase().trim()).filter(Boolean);
  const avoids     = (s.avoid_terms ?? []).map((a) => a.toLowerCase().trim()).filter((a) => a.length > 2);
  if (!priceRange && cats.length === 0 && cols.length === 0 && avoids.length === 0) return products;

  return products.filter((p) => {
    if (priceRange) {
      const pr = String(p.price_range ?? "").toLowerCase().trim();
      if (pr && pr !== priceRange) return false;
    }
    if (cats.length > 0) {
      const pc = String(p.category ?? "").toLowerCase().trim();
      if (pc && !cats.some((c) => pc.includes(c) || c.includes(pc))) return false;
    }
    if (cols.length > 0) {
      const pcol = String(p.color ?? "").toLowerCase().trim();
      if (pcol && !cols.some((c) => pcol.includes(c))) return false;
    }
    if (avoids.length > 0) {
      const hay = `${String(p.title ?? "")} ${String(p.category ?? "")} ${String(p.color ?? "")}`.toLowerCase();
      if (avoids.some((a) => hay.includes(a))) return false;
    }
    return true;
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const page: number = Math.max(0, parseInt(String(body?.page ?? 0), 10) || 0);
  const bias: BiasPayload = body?.bias ?? {};
  const brandFilter:    string = typeof body?.brandFilter    === "string" ? body.brandFilter.trim()    : "";
  const categoryFilter: string = typeof body?.categoryFilter === "string" ? body.categoryFilter.trim() : "";
  // Max-price cap (USD). null / missing = no cap. Validated to a positive
  // finite number; anything else collapses to null. Applied as an Algolia
  // numeric filter AND a lenient post-filter (keeps rows missing a price).
  const priceMaxRaw = body?.priceMax;
  const priceMax: number | null =
    typeof priceMaxRaw === "number" && Number.isFinite(priceMaxRaw) && priceMaxRaw > 0
      ? priceMaxRaw
      : null;
  const steerInterp: SteerInterp | null = body?.steerInterp ?? null;
  const steerQueryRaw: string = typeof body?.steerQuery === "string" ? body.steerQuery.trim() : "";
  const steerQuery = hasSteerSignals(steerInterp)
    ? buildSteerQuery(steerInterp)
    : steerQueryRaw;

  // Object IDs the user has liked this session (+ carried over from
  // localStorage across sessions). Drives the FashionCLIP similarity boost
  // — the centroid of these vectors becomes the similarity query against
  // Pinecone, and matches re-rank the Algolia output. Capped to the 20
  // most-recent so a long-running session doesn't inflate the Pinecone
  // fetch payload.
  const likedProductIds: string[] = Array.isArray(body?.likedProductIds)
    ? (body.likedProductIds as unknown[])
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .slice(0, 20)
    : [];

  // Diversify-by-brand mode (set by the /admin/label labeling tool). When
  // true the scoped path replaces its single big top-of-ranking fetch with
  // multiple parallel offset queries spread through the catalog, then
  // round-robin interleaves by brand. Surfaces a much wider brand spread
  // in the first batch — without this, the first 384 results are the top
  // of desc(price) and naturally clump into 3-5 luxury brands.
  const diversify: boolean = body?.diversify === true;

  // Signed-in user token — drives the taste-vector boost (onboarding age
  // centroid + upload centroid + session centroid, blended per
  // lib/taste-profile.loadUserTasteVector). Empty/anon means no taste
  // vector and the route falls back to liked-products-only behaviour.
  const userToken: string = typeof body?.userToken === "string" ? body.userToken.trim() : "";

  const appId = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? "BSDU5QFOT3";
  const key   = process.env.ALGOLIA_SEARCH_KEY
    ?? process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_KEY
    ?? process.env.ALGOLIA_ADMIN_KEY;

  if (!appId || !key) {
    return NextResponse.json({ error: "Missing Algolia credentials" }, { status: 500 });
  }

  const attributesToRetrieve = [
    "objectID", "title", "brand", "retailer", "price",
    "image_url", "product_url",
    "category", "color", "price_range", "aesthetic_tags",
    // English back-fills written by scripts/translate-non-english.mjs.
    // Frontend prefers these when present (see app/shop/page.tsx,
    // app/dashboard/page.tsx) so non-English brand sites read in English
    // on the in-app surface; outbound link still goes to the native site.
    "title_en", "description_en", "original_language",
  ];

  // Resolve scope filters. Brand and category are mutually exclusive — the UI
  // only ever sends one. If both arrive, brand wins (narrower scope, matches
  // pre-existing behavior where /brands cards deep-link into /shop).
  const brandFilterQuery = brandFilter
    ? `brand:"${brandFilter.replace(/"/g, '\\"')}" OR retailer:"${brandFilter.replace(/"/g, '\\"')}"`
    : "";
  const categoryScope = !brandFilter && categoryFilter ? scopeForCategory(categoryFilter) : null;

  try {
    const client = algoliasearch(appId, key);

    if (brandFilterQuery || categoryScope) {
      // Scoped mode (brand OR category). Steer query folds in as optionalWords
      // so it rank-boosts rather than narrowing. Bias likes also rank-boost
      // within the scope. Dislikes are NOT applied as a post-filter here — a
      // whole scope shouldn't get trimmed by cross-scope dislikes.
      const biasQuery = hasLikedSignals(bias) ? buildQueryFromBias(bias) : "";
      const scopedKeywords = categoryScope?.keywords?.join(" ") ?? "";
      const q = [steerQuery, biasQuery, scopedKeywords].filter(Boolean).join(" ");
      const optionalWords = q ? q.split(/\s+/).filter(Boolean) : undefined;
      // Combine scope filter with the price cap. Algolia accepts numeric
      // comparisons inside `filters` (e.g. `price <= 250`). Missing-price
      // rows survive the Algolia pass and are handled by the post-filter.
      const filters = composeFilters(
        brandFilterQuery || categoryScope?.filters || "",
        priceMax,
      );

      // Run Algolia + CLIP similarity in parallel — CLIP typically adds
      // 50–150ms which overlaps with Algolia's ~200ms, keeping total
      // latency near Algolia-alone.
      //
      // When a price cap is set we DROP the "custom" tier from the ranking
      // chain. The index's customRanking is `desc(price)`, so by default
      // a query like "Bottoms under $250" returns only items priced
      // $240–$250 (the top of the band under the cap), which defeats the
      // point of the filter — the user wants a diverse look at what's
      // affordable, not the single most-expensive item fitting each cap.
      // Removing "custom" falls back to the default ranking chain
      // (typo/geo/words/filters/proximity/attribute/exact), and our own
      // aesthetic×brand interleaver spreads the result.
      // The index's `customRanking: ["desc(price)"]` sorts every result set
      // by price descending. When the user caps at e.g. $500, the first page
      // ends up being 384 products all priced $475–$500 — the top of the band
      // under the cap. Unhelpful: the user wanted range, not just the most
      // expensive item they can afford.
      //
      // Algolia v5 doesn't accept a per-query `customRanking` / `ranking`
      // override through this SDK (the parameter is silently dropped). And
      // deep-offset walking is gated by Algolia's 1000-hit paginationLimitedTo.
      //
      // Instead we split the [0, priceMax] range into N logarithmic-ish bands
      // and fire one query per band. Each band's result is small and clusters
      // at the TOP of its own band (because of desc(price)), but the
      // interleaved whole covers the full affordability spectrum — from a
      // handful of items near the cap down to budget picks. Exactly what a
      // user who set a price cap wants to see.
      //
      // Pagination walks within each band: display page N pulls band's page N
      // via Algolia pagination. When a band runs dry its slot stays empty
      // and the mix drifts toward the cheaper bands — acceptable for now.
      let products: Array<Record<string, unknown>>;
      let nbHits = 0;

      if (priceMax != null) {
        // 5 logarithmic-ish price bands from the cap down. The last band
        // stretches to $0 so no product slips through the cracks. Ratios
        // chosen so each band has roughly comparable inventory — the
        // catalog is heavier at the top, so lower bands get wider.
        const bandBreakpoints = [
          priceMax,
          priceMax * 0.7,
          priceMax * 0.4,
          priceMax * 0.2,
          priceMax * 0.08,
          0,
        ];
        const bands: Array<{ lo: number; hi: number }> = [];
        for (let i = 0; i < bandBreakpoints.length - 1; i++) {
          bands.push({ hi: bandBreakpoints[i], lo: bandBreakpoints[i + 1] });
        }
        const PER_BAND = Math.ceil(SCOPED_FETCH / bands.length);

        const results = await Promise.all(
          bands.map(async (band) => {
            const scopePart = brandFilterQuery || categoryScope?.filters || "";
            const pricePart = band.lo > 0
              ? `price > ${band.lo} AND price <= ${band.hi}`
              : `price <= ${band.hi}`;
            const bandFilters = scopePart
              ? `(${scopePart}) AND (${pricePart})`
              : pricePart;
            try {
              const r = await client.searchSingleIndex({
                indexName: INDEX_NAME,
                searchParams: {
                  query:       q,
                  ...(optionalWords ? { optionalWords } : {}),
                  filters:     bandFilters,
                  hitsPerPage: PER_BAND,
                  page,
                  attributesToRetrieve,
                },
              });
              return { hits: (r.hits ?? []) as Array<Record<string, unknown>>, nbHits: r.nbHits ?? 0 };
            } catch (e) {
              console.warn("[shop-all] price-band slice failed:", e instanceof Error ? e.message : e);
              return { hits: [] as Array<Record<string, unknown>>, nbHits: 0 };
            }
          }),
        );

        nbHits = results.reduce((s, r) => s + r.nbHits, 0);

        // Round-robin interleave across bands so each page spans the full
        // price range — one item from the top band, then the next band
        // down, and so on.
        products = [];
        for (let i = 0; i < PER_BAND; i++) {
          for (let j = 0; j < results.length; j++) {
            const hit = results[j]?.hits?.[i];
            if (hit) products.push(hit);
          }
        }
      } else if (diversify) {
        // Maximum brand variety for the labeling tool. Two-stage pull:
        //
        // 1. FACET QUERY — enumerate every brand that appears in this
        //    category (up to 1000 distinct values). Single Algolia call,
        //    no products fetched. Cheap.
        //
        // 2. PER-BRAND QUERIES — fire parallel hitsPerPage=8 queries scoped
        //    to each brand. ~80 queries per page-load for a typical
        //    category. Each query returns up to 8 items from that brand.
        //
        // 3. ROUND-ROBIN — first item of each brand, then second of each,
        //    etc. The first N items of the output are N distinct brands
        //    (capped at the brand count). For a category with 80 brands
        //    in the catalog, the first 80 visible products show 80
        //    different brands — full coverage from the start.
        //
        // The previous single-1000-hit approach hit Algolia's price-desc
        // ranking ceiling: only 51 of 2747 shoes' brands could fit in the
        // top-1000 by price, so 51 was the hard ceiling per page. This
        // approach has no such ceiling.

        // Step 1 — facet query.
        const facetRes = await client.searchSingleIndex({
          indexName: INDEX_NAME,
          searchParams: {
            query:                q,
            ...(optionalWords ? { optionalWords } : {}),
            ...(filters ? { filters } : {}),
            hitsPerPage:          0,
            facets:               ["brand"],
            maxValuesPerFacet:    1000,
          },
        });
        nbHits = facetRes.nbHits ?? 0;

        const brandCounts: Record<string, number> = (facetRes.facets?.brand ?? {}) as Record<string, number>;
        // Sort brands by item count descending — common brands first means
        // the round-robin head is dominated by brands that have plenty of
        // inventory, with rarer brands (1-2 items) trailing. Slightly
        // better UX than alphabetical (which would put "8rb4" before
        // "Khaite") and slightly better recall than ascending (no point
        // putting 1-item brands at the very top of the head).
        const brandNames = Object.entries(brandCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([brand]) => brand);

        // Step 2 — parallel per-brand queries. PER_BRAND=8 gives us enough
        // depth to fill multiple pages from a single fetch (8 brands worth
        // each "Load more" turn).
        const PER_BRAND = 8;
        const scopeFilter = brandFilterQuery || categoryScope?.filters || "";
        const brandHits = await Promise.all(
          brandNames.map(async (brand) => {
            try {
              const escaped = brand.replace(/"/g, '\\"');
              const perBrandFilters = scopeFilter
                ? `(${scopeFilter}) AND brand:"${escaped}"`
                : `brand:"${escaped}"`;
              const r = await client.searchSingleIndex({
                indexName: INDEX_NAME,
                searchParams: {
                  query:       q,
                  ...(optionalWords ? { optionalWords } : {}),
                  filters:     perBrandFilters,
                  hitsPerPage: PER_BRAND,
                  page:        0,
                  attributesToRetrieve,
                },
              });
              return (r.hits ?? []) as Array<Record<string, unknown>>;
            } catch (e) {
              console.warn(`[shop-all] diversify per-brand query failed for "${brand}":`, e instanceof Error ? e.message : e);
              return [] as Array<Record<string, unknown>>;
            }
          }),
        );

        // Step 3 — round-robin. First pass takes one from each brand,
        // second pass another from each brand, etc. Brands that run out
        // early (only 1-2 items) drop from the rotation; brands with deep
        // inventory keep contributing.
        const buckets = brandHits.map((arr) => arr.slice());
        const interleaved: Array<Record<string, unknown>> = [];
        let anyLeft = true;
        while (anyLeft) {
          anyLeft = false;
          for (const bucket of buckets) {
            const item = bucket.shift();
            if (item) { interleaved.push(item); anyLeft = true; }
          }
        }

        // Slice for the requested page.
        const start = page * SCOPED_FETCH;
        products = interleaved.slice(start, start + SCOPED_FETCH);
      } else {
        const res = await client.searchSingleIndex({
          indexName: INDEX_NAME,
          searchParams: {
            query:       q,
            ...(optionalWords ? { optionalWords } : {}),
            ...(filters ? { filters } : {}),
            hitsPerPage: SCOPED_FETCH,
            page,
            attributesToRetrieve,
          },
        });
        products = (res.hits ?? []) as Array<Record<string, unknown>>;
        nbHits   = res.nbHits ?? 0;
      }

      // CLIP similarity + taste-vector similarity run in parallel. The
      // CLIP lane needs liked-product vectors; the taste-vector lane hits
      // Pinecone directly against the user's composed onboarding centroid.
      // Both return ranked objectID lists; `mergeRankedIds` fuses them by
      // reciprocal rank so items surfacing in both lanes float to the top.
      const [clipIds, taste] = await Promise.all([
        clipSimilarityRanking(likedProductIds),
        // Resolve the categoryFilter ("Tops", "Bags and accessories"...) into
        // the slug taste-profile uses internally ("tops", "bags-and-accessories").
        // Brand-mode requests have no category context, so we pass null.
        tasteVectorRanking(userToken, slugFromFilter(categoryFilter || null)),
      ]);
      const boostIds = mergeRankedIds(clipIds, taste.ids);

      // Structured Steer post-filter (price tier / category / color / avoid).
      products = applySteerPostFilter(products, steerInterp);

      // Lenient price-cap post-filter. Only drops rows that HAVE a price
      // above the cap — rows with a null / missing price survive so the
      // Algolia filter (which already dropped priced-too-high rows) stays
      // the source of truth.
      products = applyPriceMaxPostFilter(products, priceMax);

      // Strict category-scope enforcement — defensive against mis-tagged rows
      // in the Algolia index (e.g. hoodies slipping into Shoes).
      if (categoryScope?.enforce) {
        products = products.filter(categoryScope.enforce);
      }

      let clean = products.filter((h) => {
        const u = h.image_url;
        return typeof u === "string" && u.startsWith("http");
      });

      // Diversify across aesthetic × brand so the first N products span as
      // many style dimensions as the pool has. Speeds up preference
      // elicitation: each like/dislike narrows the feed across multiple
      // axes at once instead of reinforcing a single clump.
      //
      // SKIPPED when `diversify: true` — the labeling tool already ran a
      // pure brand round-robin over a 1000-item Algolia max, which puts
      // maximum brand variety in the first N slots. interleaveByAesthetic
      // would re-group by aesthetic (clumping minimalist brands together)
      // and undo that work. Same reason we skip spreadByBrand: the round-
      // robin already places the same brand >50 slots apart on average.
      if (!diversify) {
        clean = interleaveByAestheticAndBrand(clean);
        if (!brandFilterQuery) clean = spreadByBrand(clean, 4);
      }

      // Similarity boost — merged liked-products + onboarding-taste ranking.
      // boostByClipSimilarity's historical `likedCount >= 2` floor was about
      // trusting noisy session accumulation; a present taste vector is a
      // deliberate signal that should fire from the first request, so we
      // floor to 2 when the vector is available.
      clean = boostByClipSimilarity(
        clean,
        boostIds,
        Math.max(likedProductIds.length, taste.hasVector ? 2 : 0),
      );

      // Brand-age affinity demote — pushes products from brands whose curated
      // demographic doesn't include the user's age toward the end of the
      // list. Soft only: nothing is filtered out, just reordered. Skipped
      // in brand-mode since the entire pool is one brand by definition.
      if (!brandFilterQuery) {
        clean = applyBrandAgePenalty(clean as Array<Record<string, unknown> & { brand?: string; retailer?: string }>, taste.userAge) as typeof clean;
      }

      return NextResponse.json({
        products: clean,
        page,
        hasMore:  products.length >= SCOPED_FETCH / 2, // pages of ≥50% fill keep paginating
        mode:     brandFilterQuery ? "brand" : "category",
        brand:    brandFilter    || undefined,
        category: categoryFilter || undefined,
        steer:    steerQuery     || undefined,
        total:    nbHits || null,
      });
    }

    // ── Query-driven path: session signals without a hard scope ──────────
    if (steerQuery || hasLikedSignals(bias) || likedProductIds.length > 0) {
      const biasQuery = hasLikedSignals(bias) ? buildQueryFromBias(bias) : "";
      const q = [steerQuery, biasQuery].filter(Boolean).join(" ");
      const optionalWords = q.split(/\s+/).filter(Boolean);
      const filters = composeFilters("", priceMax);
      const [res, clipIds, taste] = await Promise.all([
        client.searchSingleIndex({
          indexName: INDEX_NAME,
          searchParams: {
            query:       q,
            optionalWords,
            ...(filters ? { filters } : {}),
            hitsPerPage: HITS_PER_PAGE,
            page,
            attributesToRetrieve,
          },
        }),
        clipSimilarityRanking(likedProductIds),
        // Query-driven path has no hard category scope, so we pass null —
        // taste-profile averages across populated categories for the user's age.
        tasteVectorRanking(userToken, null),
      ]);
      const boostIds = mergeRankedIds(clipIds, taste.ids);
      let products = (res.hits ?? []) as Array<Record<string, unknown>>;

      const dislikedBrands     = new Set((bias.dislikedBrands     ?? []).map((s) => s.toLowerCase()));
      const dislikedCategories = new Set((bias.dislikedCategories ?? []).map((s) => s.toLowerCase()));
      if (dislikedBrands.size > 0 || dislikedCategories.size > 0) {
        products = products.filter((p) => {
          const b = String((p.brand ?? p.retailer ?? "")).toLowerCase();
          const c = String((p.category ?? "")).toLowerCase();
          if (dislikedBrands.has(b)) return false;
          if (c && dislikedCategories.has(c)) return false;
          return true;
        });
      }

      products = applySteerPostFilter(products, steerInterp);
      products = applyPriceMaxPostFilter(products, priceMax);

      let clean = products.filter((p) => {
        const u = p.image_url;
        return typeof u === "string" && u.startsWith("http");
      });

      clean = interleaveByBrand(clean);
      clean = boostByClipSimilarity(
        clean,
        boostIds,
        Math.max(likedProductIds.length, taste.hasVector ? 2 : 0),
      );
      clean = applyBrandAgePenalty(clean as Array<Record<string, unknown> & { brand?: string; retailer?: string }>, taste.userAge) as typeof clean;

      return NextResponse.json({
        products: clean,
        page,
        hasMore: (res.hits?.length ?? 0) >= HITS_PER_PAGE,
        mode:    steerQuery ? (hasLikedSignals(bias) ? "steered+biased" : "steered") : "biased",
        query:   q,
      });
    }

    // ── Default path: simple paginated catalog walk ──────────────────────
    //
    // Previously this lane used an 8-slice interleave that fired parallel
    // queries at offsets across the catalog (0, 15k, 30k, …). That broke
    // against Algolia's `paginationLimitedTo` (1000 hits) — 7 of the 8
    // slices asked for offsets > 1000 and silently got zero hits, which
    // tripped the `hasMore` check on page 0 and pinned the result set at
    // ~42 items total.
    //
    // No live surface uses this mode on top of the multi-slice guarantee —
    // /shop always sends a brand or category filter, so the scoped path
    // upstream handles pagination. The only consumer is /admin/label, which
    // wants a big raw pool to cherry-pick a gold eval set from. Straight
    // Algolia pagination at a generous page size is the right shape:
    // gets ~1000 items across 10 pages, which is plenty for labeling.
    const FLAT_HITS_PER_PAGE = 96;
    const res = await client.searchSingleIndex({
      indexName: INDEX_NAME,
      searchParams: {
        query:       "",
        hitsPerPage: FLAT_HITS_PER_PAGE,
        page,
        attributesToRetrieve,
      },
    });
    const products = ((res.hits ?? []) as Array<Record<string, unknown>>).filter((h) => {
      const u = h.image_url;
      return typeof u === "string" && u.startsWith("http");
    });
    const hasMore = (res.hits?.length ?? 0) >= FLAT_HITS_PER_PAGE;

    return NextResponse.json({
      products,
      page,
      hasMore,
      mode:  "flat",
      total: res.nbHits ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shop-all] failed:", message);
    return NextResponse.json({ error: "Failed", detail: message }, { status: 500 });
  }
}
