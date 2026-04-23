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

export async function searchProducts(
  query:           string,
  aestheticTags:   string[],
  priceRange:      string,
  maxResults  = 6,
  categoryFilter?: string,
  userToken?:      string
): Promise<AlgoliaProduct[]> {
  const client = getClient();

  const tagFilters = aestheticTags
    .slice(0, 6)
    .map((tag) => `aesthetic_tags:${tag}`);

  const filters = categoryFilter
    ? `(${priceFilter(priceRange)}) AND ${categoryFilter}`
    : priceFilter(priceRange);

  // Request many more than needed — ~75% of index has no/broken images, so we need extras
  const results = await client.searchSingleIndex({
    indexName: INDEX_NAME,
    searchParams: {
      query,
      hitsPerPage:           maxResults * 8,
      optionalFilters:       tagFilters,
      filters,
      clickAnalytics:        true,
      enablePersonalization: true,
      ...(userToken ? { userToken } : {}),
      attributesToRetrieve: [
        "objectID", "title", "brand", "price", "price_range",
        "color", "material", "description", "image_url", "images",
        "product_url", "retailer", "aesthetic_tags", "category", "scraped_at",
        // English back-fills (see scripts/translate-non-english.mjs).
        "title_en", "description_en", "original_language",
      ],
    },
  });

  const queryID = (results as unknown as { queryID?: string }).queryID;
  const hits    = results.hits as unknown as AlgoliaProduct[];

  // Attach queryID + 1-indexed position to each hit for Insights click events
  const annotated = hits.map((h, i) => ({
    ...h,
    _queryID:  queryID ?? "",
    _position: i + 1,
  }));

  // Only keep products with a real, non-placeholder image
  const withImages = annotated.filter((h) => {
    const img = h.image_url ?? "";
    return img.length > 20 && !img.includes("blank.gif") && !img.includes("placeholder");
  });

  // Max 3 per retailer for variety (increased from 2 to help with sparse image data)
  const retailerCount: Record<string, number> = {};
  const deduped = withImages.filter((h) => {
    const count = retailerCount[h.retailer] ?? 0;
    if (count >= 3) return false;
    retailerCount[h.retailer] = count + 1;
    return true;
  });

  return deduped.slice(0, maxResults);
}

// Run multiple queries for a single category, merge and dedup by objectID.
// Falls back to no-category filter if the strict category has sparse data.
async function searchCategory(
  queries:        string[],
  aestheticTags:  string[],
  priceRange:     string,
  category:       ClothingCategory,
  maxPerCategory: number,
  userToken?:     string
): Promise<AlgoliaProduct[]> {
  const perQuery       = Math.max(3, Math.ceil((maxPerCategory * 2) / queries.length));
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

  // If we got enough, return now
  if (merged.length >= Math.max(2, Math.floor(maxPerCategory / 2))) {
    return merged.slice(0, maxPerCategory);
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

  if (merged.length >= 2) return merged.slice(0, maxPerCategory);

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

  return merged.slice(0, maxPerCategory);
}

// Category-aware search: 6 parallel buckets, 8 candidates each = 48 total
export async function searchByCategory(
  categoryQueries:     Record<ClothingCategory, string[]>,
  aestheticTags:       string[],
  priceRange:          string,
  candidatesPerCategory = 8,
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

// Fetch full product records by objectID (used after Pinecone visual search)
export async function getProductsByIds(objectIDs: string[]): Promise<AlgoliaProduct[]> {
  if (!objectIDs.length) return [];
  const client = getClient();

  // Algolia getObjects returns results in same order as requested IDs
  const res = await client.getObjects({
    requests: objectIDs.map((id) => ({
      indexName:            INDEX_NAME,
      objectID:             id,
      attributesToRetrieve: [
        "objectID", "title", "brand", "price", "price_range",
        "color", "material", "description", "image_url", "images",
        "product_url", "retailer", "aesthetic_tags", "category", "scraped_at",
        // English back-fills (see scripts/translate-non-english.mjs).
        "title_en", "description_en", "original_language",
      ],
    })),
  });

  return (res.results as AlgoliaProduct[]).filter(
    (p) => p?.objectID && p.image_url?.startsWith("http") && !p.image_url.includes("placeholder")
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
