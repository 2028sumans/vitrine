/**
 * Cheap, deterministic query-type classifier. Outputs a count of "literal
 * anchors" — tokens in the user's typed query that map to known brands,
 * specific garments, or color words. The retrieval pipeline uses this to
 * decide:
 *
 *   literalAnchorCount >= 2 → query is dominantly literal ("blue khaite
 *                              dress"). Skip the FashionCLIP semantic gate
 *                              (Algolia exhaustively covers this) and use
 *                              MMR λ=0.1 (variations welcome).
 *
 *   literalAnchorCount == 1 → mixed ("khaite party dress"). Keep both gates
 *                              and MMR λ=0.3 (default).
 *
 *   literalAnchorCount == 0 → pure abstract aesthetic ("y2k party",
 *                              "old money", "dad chic"). Stage 1b is
 *                              critical and MMR λ=0.4 (variety > similarity).
 *
 * No ML. Uses a pre-loaded brand list from Algolia facets (refreshed on a
 * 6-hour TTL) plus hand-curated garment/color word lists. Fast — runs in
 * sub-millisecond per query.
 */

import { algoliasearch } from "algoliasearch";

// ── Hand-curated literal vocabularies ────────────────────────────────────────
// These cover the obvious garment and color tokens. Brand list comes from
// Algolia (loaded lazily). Lowercase for case-insensitive matching.

const KNOWN_GARMENTS = new Set<string>([
  // Dresses & full-body
  "dress", "gown", "kaftan", "caftan", "jumpsuit", "romper", "bodysuit",
  // Tops
  "top", "shirt", "blouse", "tee", "tank", "cami", "camisole", "polo",
  "hoodie", "sweatshirt", "sweater", "cardigan", "jumper", "henley",
  "bralette", "bustier", "corset", "crop",
  // Bottoms
  "skirt", "pants", "trousers", "trouser", "jeans", "jean", "shorts",
  "leggings", "tights", "culottes", "chinos", "joggers", "sweatpants",
  // Outerwear
  "jacket", "coat", "blazer", "trench", "parka", "anorak", "windbreaker",
  "cardigan", "vest", "puffer", "bomber",
  // Footwear
  "sneaker", "sneakers", "trainer", "trainers", "loafer", "loafers",
  "mule", "mules", "sandal", "sandals", "heel", "heels", "stiletto",
  "boot", "boots", "bootie", "booties", "clog", "moccasin", "oxford",
  "espadrille", "slingback",
  // Bags
  "bag", "tote", "clutch", "satchel", "backpack", "handbag", "purse",
  "crossbody", "shoulder", "messenger", "duffle",
  // Swim
  "bikini", "swimsuit", "tankini", "monokini",
]);

const KNOWN_COLORS = new Set<string>([
  "black", "white", "cream", "ivory", "beige", "tan", "khaki", "olive",
  "navy", "blue", "denim", "indigo", "teal", "turquoise", "aqua",
  "red", "burgundy", "wine", "maroon", "crimson",
  "pink", "rose", "blush", "fuchsia", "magenta",
  "purple", "lavender", "lilac", "violet",
  "yellow", "mustard", "ochre", "amber",
  "orange", "coral", "peach", "rust",
  "green", "sage", "forest", "emerald", "mint",
  "brown", "chocolate", "caramel", "camel", "cognac",
  "grey", "gray", "silver", "charcoal",
  "gold", "metallic", "rose-gold",
]);

// ── Brand cache ──────────────────────────────────────────────────────────────
// Loaded on first use, refreshed every 6 hours. Algolia facets gives us all
// distinct brand values in one fast call.
let _brandCache: Set<string> | null = null;
let _brandCacheLoadedAt = 0;
const BRAND_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function loadBrands(): Promise<Set<string>> {
  if (_brandCache && Date.now() - _brandCacheLoadedAt < BRAND_CACHE_TTL_MS) {
    return _brandCache;
  }
  try {
    const client = algoliasearch(
      process.env.ALGOLIA_APP_ID!,
      process.env.ALGOLIA_SEARCH_KEY!,
    );
    // Facet search returns distinct brand names. We pull a generous limit
    // since the catalog has ~700 brands and they all fit in one response.
    const res = await client.searchSingleIndex({
      indexName: "vitrine_products",
      searchParams: {
        query:        "",
        facets:       ["brand"],
        hitsPerPage:  0,
        maxValuesPerFacet: 1000,
      },
    });
    const brands = Object.keys(res.facets?.brand ?? {});
    // Brands are often multi-word ("Annie's Ibiza", "Cult Gaia"). Index by
    // lowercase tokens — when scanning a query we match any brand whose
    // token list is fully present in the query.
    _brandCache = new Set(brands.map((b) => b.toLowerCase().trim()));
    _brandCacheLoadedAt = Date.now();
    return _brandCache;
  } catch (err) {
    console.warn("[query-classifier] brand load failed:", err instanceof Error ? err.message : err);
    return _brandCache ?? new Set();
  }
}

// ── Classification ───────────────────────────────────────────────────────────

export interface QueryClassification {
  hasBrand:    boolean;
  hasGarment:  boolean;
  hasColor:    boolean;
  /** Total count of literal anchor types matched. 0–3. */
  anchorCount: number;
  /** "abstract" | "mixed" | "literal" — derived from anchorCount. */
  type:        "abstract" | "mixed" | "literal";
}

/**
 * Classify a raw user query. Empty / undefined query → "abstract" (treat
 * Pinterest/quiz briefs as abstract since the user didn't type literals).
 *
 * Multi-word brand matching: a brand like "Cult Gaia" is detected when both
 * tokens appear anywhere in the query (order-insensitive).
 */
export async function classifyQuery(rawQuery: string | undefined | null): Promise<QueryClassification> {
  const q = (rawQuery ?? "").toLowerCase().trim();
  if (!q) {
    return { hasBrand: false, hasGarment: false, hasColor: false, anchorCount: 0, type: "abstract" };
  }

  const tokens   = new Set(q.split(/\s+/).filter(Boolean));
  const brands   = await loadBrands();

  // tsconfig target predates ES2015 iterators, so we materialise the Set into
  // an Array before iterating. Brand list is bounded (~700 names) — cheap.
  let hasBrand = false;
  for (const brand of Array.from(brands)) {
    const brandTokens = brand.split(/\s+/).filter(Boolean);
    if (brandTokens.length === 0) continue;
    // Multi-word brand: every token of the brand must appear in the query.
    if (brandTokens.every((bt: string) => tokens.has(bt))) {
      hasBrand = true;
      break;
    }
  }

  const hasGarment = Array.from(tokens).some((t) => KNOWN_GARMENTS.has(t));
  const hasColor   = Array.from(tokens).some((t) => KNOWN_COLORS.has(t));

  const anchorCount = (hasBrand ? 1 : 0) + (hasGarment ? 1 : 0) + (hasColor ? 1 : 0);
  const type: "abstract" | "mixed" | "literal" =
    anchorCount >= 2 ? "literal" :
    anchorCount === 1 ? "mixed" :
    "abstract";

  return { hasBrand, hasGarment, hasColor, anchorCount, type };
}
