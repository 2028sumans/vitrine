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
  // Set by search layer — needed for Insights click events
  _queryID?:      string;
  _position?:     number;
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

  const results = await client.searchSingleIndex({
    indexName: INDEX_NAME,
    searchParams: {
      query,
      hitsPerPage:           maxResults * 3,
      optionalFilters:       tagFilters,
      filters,
      clickAnalytics:        true,
      enablePersonalization: true,
      ...(userToken ? { userToken } : {}),
      attributesToRetrieve: [
        "objectID", "title", "brand", "price", "price_range",
        "color", "material", "description", "image_url", "images",
        "product_url", "retailer", "aesthetic_tags", "category",
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

  // Max 2 per retailer for variety
  const retailerCount: Record<string, number> = {};
  const deduped = annotated.filter((h) => {
    const count = retailerCount[h.retailer] ?? 0;
    if (count >= 2) return false;
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

  // Fallback — category is sparse in the index; search without category filter
  // Add the category as a keyword hint in each query so results lean that direction
  const categoryHints: Record<ClothingCategory, string> = {
    dress:  "",         // dresses dominate — no extra hint needed
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
