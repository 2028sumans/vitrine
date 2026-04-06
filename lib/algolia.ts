import { algoliasearch } from "algoliasearch";

const INDEX_NAME = "vitrine_products";

export interface AlgoliaProduct {
  objectID:      string;
  title:         string;
  brand:         string;
  price:         number | null;
  price_range:   string;
  color:         string;
  material:      string;
  description:   string;
  image_url:     string;
  images:        string[];
  product_url:   string;
  retailer:      string;
  aesthetic_tags: string[];
  category?:     string; // populated after re-index
}

// The 6 canonical clothing categories the pipeline always covers
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
  if (priceRange === "budget")  return "price_range:budget";
  if (priceRange === "luxury")  return "price_range:luxury OR price_range:mid";
  return "price_range:mid OR price_range:budget";
}

export async function searchProducts(
  query:          string,
  aestheticTags:  string[],
  priceRange:     string,
  maxResults = 6,
  categoryFilter?: string  // e.g. "category:dress" — optional, used when index has category field
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
      hitsPerPage: maxResults * 3,
      optionalFilters: tagFilters,
      filters,
      attributesToRetrieve: [
        "objectID", "title", "brand", "price", "price_range",
        "color", "material", "description", "image_url", "images",
        "product_url", "retailer", "aesthetic_tags", "category",
      ],
    },
  });

  const hits = results.hits as unknown as AlgoliaProduct[];

  // Max 2 per retailer for variety
  const retailerCount: Record<string, number> = {};
  const deduped = hits.filter((h) => {
    const count = retailerCount[h.retailer] ?? 0;
    if (count >= 2) return false;
    retailerCount[h.retailer] = count + 1;
    return true;
  });

  return deduped.slice(0, maxResults);
}

// Run multiple queries for a single category and merge, deduping by objectID
async function searchCategory(
  queries:        string[],
  aestheticTags:  string[],
  priceRange:     string,
  category:       ClothingCategory,
  maxPerCategory: number
): Promise<AlgoliaProduct[]> {
  const perQuery = Math.max(3, Math.ceil((maxPerCategory * 2) / queries.length));

  // Try with category filter first; the filter only helps if the index has been re-indexed
  const categoryFilter = `category:${category}`;

  const batches = await Promise.all(
    queries.map((q) =>
      searchProducts(q, aestheticTags, priceRange, perQuery, categoryFilter).catch(
        // If category filter fails (field not in index yet), fall back to no filter
        () => searchProducts(q, aestheticTags, priceRange, perQuery)
      )
    )
  );

  const seen = new Set<string>();
  const merged: AlgoliaProduct[] = [];

  for (const batch of batches) {
    for (const product of batch) {
      if (!seen.has(product.objectID)) {
        seen.add(product.objectID);
        merged.push(product);
      }
    }
  }

  return merged.slice(0, maxPerCategory);
}

// Category-aware search: runs 6 parallel category searches and returns
// structured candidates. Each category gets its own pool so Claude always
// has options across every garment type.
export async function searchByCategory(
  categoryQueries: Record<ClothingCategory, string[]>,
  aestheticTags:   string[],
  priceRange:      string,
  candidatesPerCategory = 5
): Promise<CategoryCandidates> {
  const categories: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];

  const results = await Promise.all(
    categories.map((cat) =>
      searchCategory(
        categoryQueries[cat] ?? [],
        aestheticTags,
        priceRange,
        cat,
        candidatesPerCategory
      )
    )
  );

  // Global dedup: if a product appears in multiple category pools, keep it
  // only in the first (most relevant) category
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
  maxTotal = 6
): Promise<AlgoliaProduct[]> {
  const perQuery = Math.max(3, Math.ceil((maxTotal * 1.5) / queries.length));
  const results = await Promise.all(
    queries.map((q) => searchProducts(q, aestheticTags, priceRange, perQuery))
  );

  const seen = new Set<string>();
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
