import { algoliasearch } from "algoliasearch";

const INDEX_NAME = "vitrine_products";

export interface AlgoliaProduct {
  objectID:       string;
  title:          string;
  brand:          string;
  price:          number | null;
  price_range:    string;
  color:          string;
  material:       string;
  description:    string;
  image_url:      string;
  images:         string[];
  product_url:    string;
  retailer:       string;
  aesthetic_tags: string[];
  category?:      string;
  scraped_at?:    string;
  // Set by search layer — needed for Insights click events
  _queryID?:      string;
  _position?:     number;
  // English back-fills written by scripts/translate-non-english.mjs.
  // Frontend prefers these via displayTitle / displayDescription helpers
  // for brands publishing in French / Italian / German / Portuguese / Spanish.
  // Outbound product_url still points at the native-language brand site.
  title_en?:          string;
  description_en?:    string;
  original_language?: string;
  // Set by lib/hybrid-search when ?debug=1 — per-item ranking breakdown:
  // visualCos, vibeCos, centroidCos, clickAffinity, algoliaRank, finalScore,
  // weights, mmrPos. Used by the UI's debug overlay (the "Why this?" tooltip)
  // and by us when triaging "why did THIS item rank here?". Otherwise unset.
  _debug?:            Record<string, unknown>;
}

/** Title to render in the UI: prefer the English back-fill when present. */
export function displayTitle(p: { title?: string; title_en?: string }): string {
  return (p.title_en && p.title_en.trim()) || p.title || "";
}

/** Description to render in the UI: prefer the English back-fill when present. */
export function displayDescription(p: { description?: string; description_en?: string }): string {
  return (p.description_en && p.description_en.trim()) || p.description || "";
}

export type ClothingCategory = "dress" | "top" | "bottom" | "jacket" | "shoes" | "bag";

export interface CategoryCandidates {
  dress:   AlgoliaProduct[];
  top:     AlgoliaProduct[];
  bottom:  AlgoliaProduct[];
  jacket:  AlgoliaProduct[];
  shoes:   AlgoliaProduct[];
  bag:     AlgoliaProduct[];
}

function getClient() {
  return algoliasearch(
    process.env.ALGOLIA_APP_ID!,
    process.env.ALGOLIA_SEARCH_KEY!
  );
}

function priceFilter(priceRange: string): string {
  if (priceRange === "budget") return "price_range:budget";
  if (priceRange === "luxury") return "price_range:luxury OR price_range:mid";
  return "price_range:mid OR price_range:budget";
}

// Algolia hard-caps hitsPerPage at 1000 — past that it returns the request
// rejected. Tune the per-page chunk to the cap so a single request gets the
// most data possible; pagination handles anything beyond.
const ALGOLIA_HITS_PER_PAGE_MAX = 1000;
// Maximum pages searchProducts will paginate through. 5 × 1000 = 5000 hits
// per query is plenty for any realistic catalog query and keeps a single
// runaway "skirt" search from blowing 30 round-trips. Configurable per call.
const DEFAULT_MAX_PAGES         = 5;
// Per-retailer cap inside a single searchProducts call. Used to be 3 (chosen
// when the catalog was thinner and we wanted forced retailer variety in a
// 6-result page). Now that the per-category cap is gone and we feed the full
// pool into FashionCLIP rerank, retailer variety is no longer a critical
// concern at this layer — let a strong retailer contribute up to 10 items
// to the candidate pool, then the rerank step decides what survives. Stricter
// dedup at the rendering layer can still trim down if needed.
const PER_RETAILER_CAP          = 10;
// (#12) Adaptive pagination early-stop ratio. Once we've collected
// (maxResults × this) items with valid images, stop paginating — usually
// page 1 is enough. Below this fraction we keep paginating to compensate
// for the image-quality attrition (~75% of catalog has bad/placeholder
// images). 0.6 balances "stop early when we have enough" vs "keep going
// when the page is mostly junk."
const ADAPTIVE_EARLY_STOP_RATIO = 0.6;

export async function searchProducts(
  query:           string,
  aestheticTags:   string[],
  priceRange:      string,
  maxResults  = 6,
  categoryFilter?: string,
  userToken?:      string,
  // 0 = no extra pages, 1 = up to 2000 hits, …, DEFAULT_MAX_PAGES-1 = up to
  // 5000 hits. Internally we loop until either Algolia runs out of results
  // (page returned < hitsPerPage) or we hit this cap, whichever comes first.
  maxPages   = DEFAULT_MAX_PAGES,
): Promise<AlgoliaProduct[]> {
  const client = getClient();

  const tagFilters = aestheticTags
    .slice(0, 6)
    .map((tag) => `aesthetic_tags:${tag}`);

  const filters = categoryFilter
    ? `(${priceFilter(priceRange)}) AND ${categoryFilter}`
    : priceFilter(priceRange);

  // Page size: oversample 8× for the image-quality filter (~75% of catalog
  // has unusable images) but never exceed Algolia's hard limit. A maxResults
  // of unbounded (Infinity) collapses to the Algolia max.
  const desiredPerPage = Number.isFinite(maxResults) ? maxResults * 8 : ALGOLIA_HITS_PER_PAGE_MAX;
  const hitsPerPage    = Math.min(ALGOLIA_HITS_PER_PAGE_MAX, Math.max(48, desiredPerPage));

  const attributesToRetrieve = [
    "objectID", "title", "brand", "price", "price_range",
    "color", "material", "description", "image_url", "images",
    "product_url", "retailer", "aesthetic_tags", "category", "scraped_at",
    // English back-fills (see scripts/translate-non-english.mjs).
    "title_en", "description_en", "original_language",
  ];

  // Paginate. Bail when Algolia runs out (last page < full) or we hit the cap.
  // The whole loop is sequential because each request needs the previous
  // page's nbPages/hits to know whether to continue. Most realistic queries
  // never hit page 1 — pagination is only meaningful for very broad text
  // queries ("dress", "skirt") and the new 2-stage retrieval pool.
  const allHits: (AlgoliaProduct & { _queryID?: string; _position?: number })[] = [];
  let queryID: string | undefined;

  for (let page = 0; page <= maxPages; page++) {
    const results = await client.searchSingleIndex({
      indexName: INDEX_NAME,
      searchParams: {
        query,
        page,
        hitsPerPage,
        optionalFilters:       tagFilters,
        filters,
        clickAnalytics:        true,
        enablePersonalization: true,
        ...(userToken ? { userToken } : {}),
        attributesToRetrieve,
      },
    });

    if (!queryID) queryID = (results as unknown as { queryID?: string }).queryID;
    const pageHits = results.hits as unknown as AlgoliaProduct[];

    // Attach queryID + cumulative position so Insights click events match the
    // user's actual rank in the unified result set.
    const baseRank = allHits.length;
    for (let i = 0; i < pageHits.length; i++) {
      allHits.push({ ...pageHits[i], _queryID: queryID ?? "", _position: baseRank + i + 1 });
    }

    // No more pages available, or we're at the bound the caller asked for.
    if (pageHits.length < hitsPerPage) break;
    if (Number.isFinite(maxResults) && allHits.length >= maxResults) break;

    // (#12) Adaptive pagination: stop early once we've collected enough items
    // with valid (non-placeholder) images to satisfy maxResults × ADAPTIVE_
    // EARLY_STOP_RATIO. ~75% of catalog has bad images so the post-filter
    // attrition is real; this lets a typical query stop after page 1 instead
    // of always paginating to maxPages even when page 1 already covered it.
    if (Number.isFinite(maxResults)) {
      const validSoFar = allHits.reduce(
        (n, h) => n + (h.image_url && h.image_url.startsWith("http") && !h.image_url.includes("placeholder") ? 1 : 0),
        0,
      );
      if (validSoFar >= (maxResults as number) * ADAPTIVE_EARLY_STOP_RATIO) break;
    }
  }

  // Only keep products with a real, non-placeholder image
  const withImages = allHits.filter((h) => {
    const img = h.image_url ?? "";
    return img.length > 20 && !img.includes("blank.gif") && !img.includes("placeholder");
  });

  // Per-retailer cap (10) — see PER_RETAILER_CAP comment for rationale.
  const retailerCount: Record<string, number> = {};
  const deduped = withImages.filter((h) => {
    const count = retailerCount[h.retailer] ?? 0;
    if (count >= PER_RETAILER_CAP) return false;
    retailerCount[h.retailer] = count + 1;
    return true;
  });

  return Number.isFinite(maxResults) ? deduped.slice(0, maxResults) : deduped;
}

// Run multiple queries for a single category, merge and dedup by objectID.
// Falls back to no-category filter if the strict category has sparse data.
//
// Per-category cap: REMOVED (was previously slice(0, maxPerCategory)). The
// 2-stage retrieval design relies on this layer returning the full Algolia
// pool — anywhere from a handful to several thousand items — so the
// FashionCLIP rerank step has the widest possible candidate set to
// differentiate. Pagination inside searchProducts (5 pages × 1000 hits
// max = 5000) is the actual upper bound.
//
// The `maxPerCategory` parameter is kept around to size the per-page Algolia
// request and to gate the "is this category sparse?" fallback decision —
// it no longer slices the final result.
async function searchCategory(
  queries:        string[],
  aestheticTags:  string[],
  priceRange:     string,
  category:       ClothingCategory,
  maxPerCategory: number,
  userToken?:     string
): Promise<AlgoliaProduct[]> {
  const perQuery       = Math.max(3, Math.ceil((maxPerCategory * 2) / Math.max(1, queries.length)));
  const categoryFilter = `category:${category}`;

  // First pass — strict category filter
  const batches = await Promise.all(
    queries.map((q) =>
      searchProducts(q, aestheticTags, priceRange, perQuery, categoryFilter, userToken).catch(() => [] as AlgoliaProduct[])
    )
  );

  const seen   = new Set<string>();
  const merged: AlgoliaProduct[] = [];
  for (const batch of batches) {
    for (const product of batch) {
      if (!seen.has(product.objectID)) { seen.add(product.objectID); merged.push(product); }
    }
  }

  // If we got enough, return the full pool — no slice. "Enough" = at least
  // half of what was asked for so the 3-tier fallback chain still has a
  // chance to widen on truly sparse categories.
  if (merged.length >= Math.max(2, Math.floor(maxPerCategory / 2))) {
    return merged;
  }

  // Fallback 1 — category is sparse; search without category filter
  // Add the category as a keyword hint so results lean that direction
  const categoryHints: Record<ClothingCategory, string> = {
    dress:  "",
    top:    "top",
    bottom: "skirt",
    jacket: "jacket",
    shoes:  "shoes",
    bag:    "bag",
  };
  const hint = categoryHints[category];

  const fallbackBatches = await Promise.all(
    queries.map((q) => {
      const q2 = hint && !q.toLowerCase().includes(hint) ? `${q} ${hint}` : q;
      return searchProducts(q2, aestheticTags, priceRange, perQuery, undefined, userToken).catch(() => [] as AlgoliaProduct[]);
    })
  );

  for (const batch of fallbackBatches) {
    for (const product of batch) {
      if (!seen.has(product.objectID)) { seen.add(product.objectID); merged.push(product); }
    }
  }

  if (merged.length >= 2) return merged;

  // Fallback 2 — broadest: strip to the last 1-2 words of the first query (usually color/type)
  // e.g. "cherry red satin slip dress" → "dress", "black mini skirt" → "skirt"
  // This reliably matches inventory like "Flirt Hour Mini Dress Red"
  const lastWord = queries[0]?.trim().split(" ").pop() ?? "dress";
  const secondWord = queries[0]?.trim().split(" ").slice(-2, -1)[0];
  const broadTerms = secondWord ? `${secondWord} ${lastWord}` : lastWord;
  const broadResults = await searchProducts(broadTerms, [], priceRange, maxPerCategory, undefined, userToken).catch(() => [] as AlgoliaProduct[]);
  for (const product of broadResults) {
    if (!seen.has(product.objectID)) { seen.add(product.objectID); merged.push(product); }
  }

  return merged;
}

// Category-aware search: 6 parallel buckets feeding the 2-stage retrieval
// pipeline. The per-category result list is the FULL Algolia pool for that
// category (capped only by pagination — see searchProducts). Stage 2
// (FashionCLIP rerank) consumes this pool. `candidatesPerCategory` is the
// per-page request size, not a final cap.
export async function searchByCategory(
  categoryQueries:     Record<ClothingCategory, string[]>,
  aestheticTags:       string[],
  priceRange:          string,
  candidatesPerCategory = 200,
  userToken?:           string
): Promise<CategoryCandidates> {
  const categories: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];

  const results = await Promise.all(
    categories.map((cat) =>
      searchCategory(
        categoryQueries[cat] ?? [],
        aestheticTags,
        priceRange,
        cat,
        candidatesPerCategory,
        userToken
      )
    )
  );

  // Global dedup: keep each product only in the first category it appears in
  const globalSeen = new Set<string>();
  const dedupedResults = results.map((pool) =>
    pool.filter((p) => {
      if (globalSeen.has(p.objectID)) return false;
      globalSeen.add(p.objectID);
      return true;
    })
  );

  return {
    dress:  dedupedResults[0],
    top:    dedupedResults[1],
    bottom: dedupedResults[2],
    jacket: dedupedResults[3],
    shoes:  dedupedResults[4],
    bag:    dedupedResults[5],
  };
}

// Fetch full product records by objectID (used after Pinecone visual search,
// and by /edits/[slug] to hydrate editorial product_ids).
//
// Algolia v5's getObjects throws ObjectNotFound on any missing id, which
// at build time crashes the whole `next build` of /edits/[slug]/page when
// an edit's product_ids drift out of sync with the live catalog (e.g.
// after a brand or price purge). Degrades to per-id fetches via
// Promise.allSettled so misses are silently dropped instead of taking
// down the whole list.
export async function getProductsByIds(objectIDs: string[]): Promise<AlgoliaProduct[]> {
  if (!objectIDs.length) return [];
  const client = getClient();

  const ATTRS = [
    "objectID", "title", "brand", "price", "price_range",
    "color", "material", "description", "image_url", "images",
    "product_url", "retailer", "aesthetic_tags", "category", "scraped_at",
    // English back-fills (see scripts/translate-non-english.mjs).
    "title_en", "description_en", "original_language",
  ];

  let raw: (AlgoliaProduct | null)[] = [];
  try {
    const res = await client.getObjects({
      requests: objectIDs.map((id) => ({
        indexName:            INDEX_NAME,
        objectID:             id,
        attributesToRetrieve: ATTRS,
      })),
    });
    raw = res.results as (AlgoliaProduct | null)[];
  } catch {
    const settled = await Promise.allSettled(
      objectIDs.map((id) =>
        client
          .getObject({ indexName: INDEX_NAME, objectID: id, attributesToRetrieve: ATTRS })
          .then((p) => p as unknown as AlgoliaProduct),
      ),
    );
    raw = settled.map((s) => (s.status === "fulfilled" ? s.value : null));
  }

  return raw.filter(
    (p): p is AlgoliaProduct =>
      !!p?.objectID && p.image_url?.startsWith("http") === true && !p.image_url.includes("placeholder"),
  );
}

// ── Group a flat product list into CategoryCandidates ─────────────────────────
// Used after visual search returns an ordered flat list — preserves relevance
// ranking within each category bucket.

export function groupByCategory(
  products:     AlgoliaProduct[],
  maxPerCat = 20
): CategoryCandidates {
  const buckets: CategoryCandidates = { dress: [], top: [], bottom: [], jacket: [], shoes: [], bag: [] };
  const categories = Object.keys(buckets) as ClothingCategory[];

  for (const p of products) {
    const cat = (p.category ?? "") as ClothingCategory;
    if (categories.includes(cat) && buckets[cat].length < maxPerCat) {
      buckets[cat].push(p);
    }
  }

  return buckets;
}

// Legacy flat search — kept for backwards compatibility
export async function searchByMultipleQueries(
  queries:       string[],
  aestheticTags: string[],
  priceRange:    string,
  maxTotal = 6,
  userToken?:    string
): Promise<AlgoliaProduct[]> {
  const perQuery = Math.max(3, Math.ceil((maxTotal * 1.5) / queries.length));
  const results  = await Promise.all(
    queries.map((q) => searchProducts(q, aestheticTags, priceRange, perQuery, undefined, userToken))
  );

  const seen   = new Set<string>();
  const merged: AlgoliaProduct[] = [];
  for (const batch of results) {
    for (const product of batch) {
      if (!seen.has(product.objectID)) {
        seen.add(product.objectID);
        merged.push(product);
      }
    }
  }
  return merged.slice(0, maxTotal);
}
