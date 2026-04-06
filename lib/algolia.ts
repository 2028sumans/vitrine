import { algoliasearch } from "algoliasearch";

const INDEX_NAME = "vitrine_products";

export interface AlgoliaProduct {
  objectID: string;
  title: string;
  brand: string;
  price: number | null;
  price_range: string;
  color: string;
  material: string;
  description: string;
  image_url: string;
  images: string[];
  product_url: string;
  retailer: string;
  aesthetic_tags: string[];
}

function getClient() {
  return algoliasearch(
    process.env.ALGOLIA_APP_ID!,
    process.env.ALGOLIA_SEARCH_KEY!
  );
}

export async function searchProducts(
  query: string,
  aestheticTags: string[],
  priceRange: string,
  maxResults = 6
): Promise<AlgoliaProduct[]> {
  const client = getClient();

  const tagFilters = aestheticTags
    .slice(0, 6)
    .map((tag) => `aesthetic_tags:${tag}`);

  const priceFilter =
    priceRange === "budget"
      ? "price_range:budget"
      : priceRange === "luxury"
      ? "price_range:luxury OR price_range:mid"
      : "price_range:mid OR price_range:budget";

  const results = await client.searchSingleIndex({
    indexName: INDEX_NAME,
    searchParams: {
      query,
      hitsPerPage: maxResults * 3,
      optionalFilters: tagFilters,
      filters: priceFilter,
      attributesToRetrieve: [
        "objectID",
        "title",
        "brand",
        "price",
        "price_range",
        "color",
        "material",
        "description",
        "image_url",
        "images",
        "product_url",
        "retailer",
        "aesthetic_tags",
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

export async function searchByMultipleQueries(
  queries: string[],
  aestheticTags: string[],
  priceRange: string,
  maxTotal = 6
): Promise<AlgoliaProduct[]> {
  // Fetch enough per query to give Claude real variety
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
