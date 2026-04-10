/**
 * MUSE — Channel3 Product Importer
 *
 * Fetches 100k+ women's fashion products from Channel3 and uploads to Algolia.
 * Covers major retailers + Poshmark, Depop, ThredUp (vintage/secondhand).
 *
 * Required env vars:
 *   ALGOLIA_APP_ID        — from .env.local (already set)
 *   ALGOLIA_ADMIN_KEY     — from Algolia dashboard → API Keys → Admin API Key
 *   CHANNEL3_API_KEY      — from .env.local (already set)
 *
 * Run:
 *   ALGOLIA_ADMIN_KEY=xxx node scripts/import-channel3.mjs
 *
 * Flags:
 *   --fetch-only    fetch from Channel3 and save cache, skip Algolia upload
 *   --upload-only   skip fetch, load from cache and upload to Algolia
 *   --dry-run       fetch 2 pages per query only (validate format, cheap)
 *
 * Estimated cost: ~$25–35 in Channel3 API calls for 100k products
 */

import { algoliasearch } from "algoliasearch";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { createInterface } from "readline";

// ── Config ────────────────────────────────────────────────────────────────────

const CHANNEL3_API_KEY = process.env.CHANNEL3_API_KEY;
const ALGOLIA_APP_ID   = process.env.ALGOLIA_APP_ID   ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX_NAME       = "vitrine_products";
const CHANNEL3_URL     = "https://api.trychannel3.com/v1/search";
const CACHE_FILE       = "./scripts/channel3-cache.json";

const FETCH_ONLY  = process.argv.includes("--fetch-only");
const UPLOAD_ONLY = process.argv.includes("--upload-only");
const DRY_RUN     = process.argv.includes("--dry-run");
const PROBE       = process.argv.includes("--probe");
const INSPECT     = process.argv.includes("--inspect");
const MAX_PAGES_PER_QUERY = DRY_RUN ? 2 : 80;
const TARGET_TOTAL        = DRY_RUN ? 500 : 120_000;
const BATCH_SIZE          = 1000;     // Algolia batch size
const REQUEST_DELAY_MS    = 150;      // polite delay between Channel3 calls

// ── Search queries ────────────────────────────────────────────────────────────
// Strategy: color × category matrix + style × category + vintage secondhand.
// Channel3 returns ~30-60 unique products per query, so we need ~2,000+ queries
// to reach 100k. Each query hits a different slice of the index.

const QUERY_COLORS = [
  "black", "white", "red", "blue", "green", "pink", "yellow", "orange",
  "purple", "brown", "beige", "cream", "navy", "burgundy", "olive", "sage",
  "terracotta", "coral", "mauve", "lilac", "rust", "camel", "chocolate",
  "ivory", "gold", "silver", "grey", "gray", "cobalt", "emerald",
  "champagne", "nude", "blush", "rose", "teal", "khaki", "mustard",
  "cobalt blue", "forest green", "hot pink", "light blue", "dark green",
];

const DRESS_STYLES = [
  "mini dress", "midi dress", "maxi dress", "wrap dress", "bodycon dress",
  "slip dress", "satin dress", "knit dress", "linen dress", "shirt dress",
  "floral dress", "cocktail dress", "formal gown", "summer dress",
  "party dress", "ruffle dress", "strapless dress", "backless dress",
  "cut out dress", "asymmetric dress", "tiered dress", "smocked dress",
  "sweater dress", "velvet dress", "sequin dress", "mesh dress",
];

const TOP_STYLES = [
  "blouse", "crop top", "cardigan", "tank top", "bodysuit",
  "corset top", "hoodie", "turtleneck", "off shoulder top", "sweater",
  "knit top", "button down shirt", "cami", "polo top", "tube top",
  "halter top", "wrap top", "lace top", "satin blouse", "mesh top",
];

const BOTTOM_STYLES = [
  "mini skirt", "midi skirt", "maxi skirt", "pleated skirt", "satin skirt",
  "wide leg pants", "straight leg jeans", "flare pants", "trousers",
  "shorts", "cargo pants", "leather skirt", "denim skirt", "linen pants",
  "track pants", "sweatpants", "leggings", "bike shorts", "baggy jeans",
];

const JACKET_STYLES = [
  "blazer", "leather jacket", "denim jacket", "trench coat", "puffer jacket",
  "coat", "moto jacket", "bomber jacket", "wool coat", "faux fur coat",
  "oversized blazer", "shacket", "vest", "windbreaker", "parka",
];

const SHOE_STYLES = [
  "heels", "pumps", "sandals", "ankle boots", "knee high boots",
  "sneakers", "loafers", "mules", "ballet flats", "platform shoes",
  "strappy heels", "block heels", "stilettos", "wedges", "mary janes",
  "cowboy boots", "thigh high boots", "espadrilles", "slingbacks",
];

const BAG_STYLES = [
  "handbag", "tote bag", "crossbody bag", "shoulder bag", "clutch",
  "mini bag", "bucket bag", "designer bag", "hobo bag", "satchel",
  "evening bag", "wristlet", "belt bag", "camera bag", "top handle bag",
];

const ACCESSORY_STYLES = [
  "necklace", "earrings", "sunglasses", "belt", "scarf",
  "bracelet", "ring", "hair clip", "headband", "watch",
  "gold necklace", "hoop earrings", "statement earrings", "pendant necklace",
];

// Build color × category matrix
function colorQueries() {
  const qs = [];
  for (const color of QUERY_COLORS) {
    // Sample: a few styles per color to avoid too many API calls
    const dressStyle = DRESS_STYLES[Math.floor(QUERY_COLORS.indexOf(color) % DRESS_STYLES.length)];
    qs.push({ q: `${color} dress` });
    qs.push({ q: `${color} ${dressStyle}` });
    qs.push({ q: `${color} top` });
    qs.push({ q: `${color} skirt` });
    qs.push({ q: `${color} pants` });
    qs.push({ q: `${color} blazer` });
    qs.push({ q: `${color} bag` });
    qs.push({ q: `${color} heels` });
    qs.push({ q: `${color} boots` });
    qs.push({ q: `${color} sandals` });
  }
  return qs;
}

// All style queries without color prefix
function styleQueries() {
  return [
    ...DRESS_STYLES.map((s) => ({ q: s })),
    ...TOP_STYLES.map((s) => ({ q: `${s} women` })),
    ...BOTTOM_STYLES.map((s) => ({ q: `${s} women` })),
    ...JACKET_STYLES.map((s) => ({ q: `${s} women` })),
    ...SHOE_STYLES.map((s) => ({ q: `${s} women` })),
    ...BAG_STYLES.map((s) => ({ q: s })),
    ...ACCESSORY_STYLES.map((s) => ({ q: `${s} women` })),
  ];
}

// Brand-specific queries to pull retailer-specific inventory
function brandQueries() {
  const brands = [
    "Zara", "H&M", "ASOS", "Revolve", "Anthropologie", "Free People",
    "Urban Outfitters", "Reformation", "Mango", "Uniqlo", "COS",
    "Abercrombie", "J.Crew", "Nasty Gal", "Shein", "Boohoo",
    "Nordstrom", "Shopbop", "Farfetch", "Net-a-Porter", "SSENSE",
    "Bloomingdales", "Saks", "Intermix", "Alo Yoga", "Skims",
    "Princess Polly", "Hello Molly", "Show Me Your Mumu", "Likely",
  ];
  const cats = ["dress", "top", "skirt", "pants", "jacket", "bag", "shoes"];
  const qs = [];
  for (const brand of brands) {
    for (const cat of cats) {
      qs.push({ q: `${brand} ${cat}` });
    }
  }
  return qs;
}

// Occasion / aesthetic queries
function occasionQueries() {
  return [
    { q: "wedding guest dress" },
    { q: "bridesmaid dress" },
    { q: "cocktail party dress" },
    { q: "date night outfit" },
    { q: "office workwear women" },
    { q: "vacation resort dress" },
    { q: "beach dress coverup" },
    { q: "festival outfit" },
    { q: "athleisure set women" },
    { q: "loungewear set women" },
    { q: "matching set women" },
    { q: "two piece set" },
    { q: "going out outfit" },
    { q: "brunch outfit women" },
    { q: "casual everyday outfit" },
    { q: "winter outfit women" },
    { q: "fall outfit women" },
    { q: "spring outfit women" },
    { q: "summer outfit women" },
    { q: "street style women" },
    { q: "business casual women" },
    { q: "smart casual women" },
    { q: "boho chic dress" },
    { q: "romantic feminine dress" },
    { q: "minimalist outfit" },
    { q: "edgy grunge outfit" },
    { q: "preppy outfit women" },
    { q: "y2k fashion women" },
    { q: "cottagecore dress" },
    { q: "coastal grandmother style" },
    { q: "old money aesthetic" },
    { q: "quiet luxury women" },
    { q: "dark academia outfit" },
    { q: "mob wife aesthetic" },
    { q: "ballet core outfit" },
    { q: "coquette aesthetic" },
  ];
}

// Vintage & secondhand
function vintageQueries() {
  return [
    { q: "vintage dress", condition: "used" },
    { q: "vintage mini dress", condition: "used" },
    { q: "vintage maxi dress", condition: "used" },
    { q: "vintage blazer jacket", condition: "used" },
    { q: "vintage leather jacket", condition: "used" },
    { q: "vintage coat", condition: "used" },
    { q: "vintage bag purse", condition: "used" },
    { q: "vintage designer bag", condition: "used" },
    { q: "vintage denim jeans", condition: "used" },
    { q: "vintage denim jacket", condition: "used" },
    { q: "vintage top blouse", condition: "used" },
    { q: "vintage skirt", condition: "used" },
    { q: "vintage shoes boots", condition: "used" },
    { q: "vintage accessories jewelry", condition: "used" },
    { q: "secondhand dress", condition: "used" },
    { q: "secondhand designer", condition: "used" },
    { q: "preloved luxury bag", condition: "used" },
    { q: "thrifted clothing women", condition: "used" },
    { q: "90s vintage fashion", condition: "used" },
    { q: "70s vintage boho", condition: "used" },
    { q: "80s vintage fashion", condition: "used" },
    { q: "y2k vintage clothing", condition: "used" },
    { q: "vintage silk dress", condition: "used" },
    { q: "vintage lace dress", condition: "used" },
    { q: "vintage velvet", condition: "used" },
  ];
}

const QUERIES = [
  ...colorQueries(),
  ...styleQueries(),
  ...brandQueries(),
  ...occasionQueries(),
  ...vintageQueries(),
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function priceRange(price) {
  if (!price) return "unknown";
  if (price < 50)  return "budget";
  if (price < 200) return "mid";
  return "luxury";
}

const CATEGORY_MAP = {
  dress:   ["dress", "gown", "romper", "jumpsuit", "playsuit"],
  top:     ["top", "blouse", "shirt", "tee", "tank", "cami", "sweater", "cardigan",
            "hoodie", "sweatshirt", "bodysuit", "corset", "pullover", "turtleneck"],
  bottom:  ["skirt", "pant", "trouser", "jean", "denim", "short", "legging",
            "jogger", "cargo", "culotte"],
  jacket:  ["jacket", "blazer", "coat", "trench", "vest", "puffer", "anorak",
            "bomber", "cape", "overcoat"],
  shoes:   ["shoe", "boot", "sandal", "heel", "flat", "loafer", "sneaker",
            "mule", "pump", "stiletto", "wedge", "slingback", "slide"],
  bag:     ["bag", "tote", "clutch", "handbag", "purse", "backpack", "crossbody",
            "satchel", "pouch", "wristlet"],
  accessories: ["necklace", "earring", "bracelet", "ring", "jewelry", "jewellery",
                "sunglasses", "belt", "scarf", "hat", "hair", "watch", "accessory"],
};

function extractCategory(product) {
  // 1. Try Channel3's category taxonomy
  const cats = (product.categories ?? []).join(" ").toLowerCase();
  if (cats.includes("dress") || cats.includes("gown")) return "dress";
  if (cats.includes("skirt")) return "bottom";
  if (cats.includes("pant") || cats.includes("jean") || cats.includes("trouser") || cats.includes("short")) return "bottom";
  if (cats.includes("top") || cats.includes("blouse") || cats.includes("shirt") || cats.includes("sweater") || cats.includes("cardigan")) return "top";
  if (cats.includes("jacket") || cats.includes("coat") || cats.includes("blazer") || cats.includes("outerwear")) return "jacket";
  if (cats.includes("shoe") || cats.includes("boot") || cats.includes("sandal") || cats.includes("heel") || cats.includes("sneaker") || cats.includes("loafer")) return "shoes";
  if (cats.includes("bag") || cats.includes("handbag") || cats.includes("wallet") || cats.includes("clutch") || cats.includes("tote")) return "bag";
  if (cats.includes("jewelry") || cats.includes("necklace") || cats.includes("earring") || cats.includes("bracelet") || cats.includes("ring") || cats.includes("sunglasses") || cats.includes("accessory") || cats.includes("belt") || cats.includes("scarf") || cats.includes("hat")) return "accessories";

  // 2. Fall back to title keyword matching
  const title = (product.title ?? "").toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_MAP)) {
    if (keywords.some((kw) => title.includes(kw))) return cat;
  }
  return "other";
}

const AESTHETIC_MAP = {
  minimalist:  ["minimal", "simple", "clean", "basic", "classic", "timeless", "structured"],
  bohemian:    ["boho", "floral", "wrap", "maxi", "flowy", "linen", "crochet", "embroidered", "tiered"],
  romantic:    ["lace", "ruffle", "satin", "silk", "feminine", "bow", "ribbon", "corset", "floral"],
  edgy:        ["leather", "asymmetric", "cutout", "mesh", "chain", "moto", "fishnet"],
  preppy:      ["plaid", "striped", "button", "collar", "polo", "blazer", "nautical", "gingham"],
  casual:      ["jersey", "cotton", "relaxed", "oversized", "everyday", "knit"],
  elegant:     ["satin", "silk", "velvet", "drape", "formal", "evening", "gown", "sequin"],
  party:       ["sequin", "glitter", "metallic", "mini", "bodycon", "backless", "going out"],
  y2k:         ["low rise", "velour", "rhinestone", "micro", "crop", "butterfly"],
  vintage:     ["vintage", "retro", "secondhand", "preloved", "thrifted", "90s", "80s", "70s"],
  cottagecore: ["floral", "puff sleeve", "milkmaid", "smocked", "prairie"],
  coastal:     ["linen", "stripe", "nautical", "resort", "vacation", "sundress"],
};

const COLORS = [
  "black", "white", "red", "blue", "green", "pink", "yellow", "orange",
  "purple", "brown", "beige", "cream", "navy", "burgundy", "olive", "sage",
  "terracotta", "coral", "mauve", "lilac", "rust", "camel", "chocolate",
  "ivory", "gold", "silver", "leopard", "floral", "print", "stripe",
];

function aestheticTags(text) {
  const t = (text ?? "").toLowerCase();
  const tags = [];
  for (const [aesthetic, kws] of Object.entries(AESTHETIC_MAP)) {
    if (kws.some((kw) => t.includes(kw))) tags.push(aesthetic);
  }
  for (const color of COLORS) {
    if (t.includes(color)) tags.push(color);
  }
  if (t.includes("mini"))  tags.push("mini");
  if (t.includes("midi"))  tags.push("midi");
  if (t.includes("maxi"))  tags.push("maxi");
  return [...new Set(tags)];
}

const DOMAIN_NAMES = {
  "nordstrom.com":      "Nordstrom",
  "revolve.com":        "Revolve",
  "asos.com":           "ASOS",
  "anthropologie.com":  "Anthropologie",
  "urbanoutfitters.com":"Urban Outfitters",
  "freepeople.com":     "Free People",
  "hm.com":             "H&M",
  "zara.com":           "Zara",
  "shein.com":          "SHEIN",
  "poshmark.com":       "Poshmark",
  "depop.com":          "Depop",
  "thredup.com":        "ThredUp",
  "shopbop.com":        "Shopbop",
  "farfetch.com":       "Farfetch",
  "net-a-porter.com":   "Net-a-Porter",
  "ssense.com":         "SSENSE",
  "bloomingdales.com":  "Bloomingdale's",
  "saksfifthavenue.com":"Saks Fifth Avenue",
  "intermixonline.com": "INTERMIX",
  "nastygal.com":       "Nasty Gal",
  "prettylittlething.com": "PLT",
  "boohoo.com":         "Boohoo",
  "reformation.com":    "Reformation",
  "mango.com":          "Mango",
  "uniqlo.com":         "Uniqlo",
  "cos.com":            "COS",
  "arket.com":          "ARKET",
  "& otherstories.com": "& Other Stories",
  "abercrombie.com":    "Abercrombie",
  "gap.com":            "Gap",
  "jcrew.com":          "J.Crew",
  "birdsnest.com.au":   "Birdsnest",
  "amazon.com":         "Amazon Fashion",
};

function formatRetailer(domain) {
  if (!domain) return "Shop";
  // Strip www. and country prefixes like us. uk. au. ca. de. fr.
  const clean = domain.replace(/^(?:www\.|[a-z]{2}\.)+/, "");
  return DOMAIN_NAMES[clean] ?? clean.replace(/\.com.*$/, "").split(".")[0]
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function toAlgoliaRecord(product) {
  const offers = product.offers ?? [];
  const bestOffer = offers.find((o) => o.availability === "InStock") ?? offers[0];
  const mainImage = (product.images ?? []).find((i) => i.is_main_image) ?? product.images?.[0];

  // Use title + first 150 chars of description for tagging — keep record small
  const text = [product.title, (product.description ?? "").slice(0, 150)].join(" ");

  return {
    objectID:       product.id,
    title:          (product.title ?? "").slice(0, 150),
    brand:          (product.brands?.[0]?.name ?? "").slice(0, 80),
    price:          bestOffer?.price?.price ?? null,
    price_range:    priceRange(bestOffer?.price?.price),
    color:          "",
    material:       (product.materials?.[0] ?? "").slice(0, 80),
    description:    (product.description ?? "").slice(0, 200),   // trimmed: was 500
    image_url:      mainImage?.url ?? "",
    images:         [],   // omit — image_url is enough; full array blows the 10KB limit
    product_url:    bestOffer?.url ?? "",
    retailer:       formatRetailer(bestOffer?.domain),
    aesthetic_tags: aestheticTags(text),
    category:       extractCategory(product),
    condition:      product.condition ?? "new",
  };
}

// ── Channel3 fetch ────────────────────────────────────────────────────────────

async function fetchPage(query, pageToken, condition) {
  const body = {
    query:  query,
    limit:  30,
    ...(pageToken ? { page_token: pageToken } : {}),
    filters: {
      ...(condition ? { condition } : {}),
    },
  };

  const res = await fetch(CHANNEL3_URL, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key":    CHANNEL3_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Channel3 ${res.status}: ${err.slice(0, 200)}`);
  }

  return res.json();
}

async function fetchAllProducts() {
  const seen     = new Set();
  const products = [];

  console.log(`\n📡 Fetching from Channel3 (max ${MAX_PAGES_PER_QUERY} pages/query, target ${TARGET_TOTAL.toLocaleString()} products)\n`);

  for (let qi = 0; qi < QUERIES.length; qi++) {
    const { q, condition } = QUERIES[qi];
    if (products.length >= TARGET_TOTAL) break;

    process.stdout.write(`[${qi + 1}/${QUERIES.length}] "${q}"${condition ? ` (${condition})` : ""} ... `);

    let pageToken  = null;
    let pageCount  = 0;
    let queryCount = 0;

    try {
      do {
        const data = await fetchPage(q, pageToken, condition);
        const items = data.products ?? [];

        for (const item of items) {
          if (!item.id || seen.has(item.id)) continue;
          const img = (item.images ?? []).find((i) => i.is_main_image)?.url ?? item.images?.[0]?.url ?? "";
          if (!img) continue;  // skip products with no image
          // Skip men's products (gender field or title keywords)
          if (item.gender === "male") continue;
          const titleLower = (item.title ?? "").toLowerCase();
          if (/\b(mens?|men's|boys?|boy's)\b/.test(titleLower)) continue;
          seen.add(item.id);
          products.push(item);
        }

        pageToken = data.next_page_token ?? null;
        pageCount++;
        queryCount += items.length;

        if (products.length >= TARGET_TOTAL) break;
        if (pageToken) await sleep(REQUEST_DELAY_MS);
      } while (pageToken && pageCount < MAX_PAGES_PER_QUERY);
    } catch (err) {
      process.stdout.write(`❌ ${err.message}\n`);
      continue;
    }

    console.log(`${queryCount} fetched (${pageCount}p) → ${products.length.toLocaleString()} total unique`);
  }

  return products;
}

// ── Algolia upload ────────────────────────────────────────────────────────────

async function uploadToAlgolia(products) {
  if (!ALGOLIA_ADMIN_KEY) {
    console.error("\n❌ Missing ALGOLIA_ADMIN_KEY. Get it from Algolia dashboard → API Keys → Admin API Key");
    console.error("   Then run: ALGOLIA_ADMIN_KEY=xxx node scripts/import-channel3.mjs --upload-only\n");
    process.exit(1);
  }

  const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

  // Configure index settings first
  console.log("\n⚙️  Configuring Algolia index settings...");
  await client.setSettings({
    indexName: INDEX_NAME,
    indexSettings: {
      searchableAttributes: [
        "title",
        "brand",
        "description",
        "color",
        "material",
        "aesthetic_tags",
        "retailer",
        "category",
      ],
      attributesForFaceting: [
        "filterOnly(aesthetic_tags)",
        "filterOnly(retailer)",
        "filterOnly(brand)",
        "filterOnly(price_range)",
        "filterOnly(category)",
        "filterOnly(condition)",
      ],
      customRanking: ["desc(price)"],
    },
  });

  // Clear existing index
  console.log("🗑️  Clearing existing index...");
  await client.clearObjects({ indexName: INDEX_NAME });

  // Convert and upload
  const records  = products.map(toAlgoliaRecord).filter((r) => r.image_url);
  const total    = records.length;
  console.log(`\n⬆️  Uploading ${total.toLocaleString()} products to Algolia in batches of ${BATCH_SIZE}...\n`);

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    await client.saveObjects({ indexName: INDEX_NAME, objects: batch });
    const pct = Math.round(((i + batch.length) / total) * 100);
    process.stdout.write(`\r   ${(i + batch.length).toLocaleString()} / ${total.toLocaleString()} (${pct}%)`);
  }

  // Print breakdown
  console.log("\n\n📊 Breakdown by category:");
  const cats = {};
  for (const r of records) { cats[r.category] = (cats[r.category] ?? 0) + 1; }
  Object.entries(cats).sort((a, b) => b[1] - a[1]).forEach(([cat, n]) => {
    console.log(`   ${cat.padEnd(14)} ${n.toLocaleString()}`);
  });

  console.log("\n📊 Breakdown by retailer (top 20):");
  const retailers = {};
  for (const r of records) { retailers[r.retailer] = (retailers[r.retailer] ?? 0) + 1; }
  Object.entries(retailers).sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([ret, n]) => {
    console.log(`   ${ret.padEnd(22)} ${n.toLocaleString()}`);
  });

  console.log(`\n🎉 Done! ${total.toLocaleString()} products indexed in "${INDEX_NAME}"\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function inspectCache() {
  if (!existsSync(CACHE_FILE)) {
    console.error(`❌ No cache at ${CACHE_FILE}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  console.log(`\n🔍 Inspecting ${raw.length.toLocaleString()} cached products\n`);

  let noImage = 0, badImage = 0, goodImage = 0;
  const imgPatterns = {};
  const cats = {}, retailers = {}, priceRanges = {};
  const noOfferCount = { noOffers: 0, noUrl: 0 };

  for (const p of raw) {
    const mainImg = (p.images ?? []).find((i) => i.is_main_image)?.url ?? p.images?.[0]?.url ?? "";
    if (!mainImg) {
      noImage++;
    } else if (mainImg.includes("blank") || mainImg.includes("placeholder") || mainImg.length < 20) {
      badImage++;
    } else {
      goodImage++;
      const domain = mainImg.split("/")[2] ?? "unknown";
      imgPatterns[domain] = (imgPatterns[domain] ?? 0) + 1;
    }

    const rec = toAlgoliaRecord(p);
    cats[rec.category] = (cats[rec.category] ?? 0) + 1;
    retailers[rec.retailer] = (retailers[rec.retailer] ?? 0) + 1;
    priceRanges[rec.price_range] = (priceRanges[rec.price_range] ?? 0) + 1;
    if (!p.offers?.length) noOfferCount.noOffers++;
    else if (!p.offers[0]?.url) noOfferCount.noUrl++;
  }

  const pct = (n) => `${((n / raw.length) * 100).toFixed(1)}%`;
  console.log(`📷 Image quality:`);
  console.log(`   ✅ valid image      ${goodImage.toLocaleString().padStart(7)} (${pct(goodImage)})`);
  console.log(`   ❌ no image         ${noImage.toLocaleString().padStart(7)} (${pct(noImage)})`);
  console.log(`   ⚠️  bad/placeholder  ${badImage.toLocaleString().padStart(7)} (${pct(badImage)})`);
  console.log(`\n📷 Image CDN domains:`);
  Object.entries(imgPatterns).sort((a,b)=>b[1]-a[1]).forEach(([d,n])=>console.log(`   ${d.padEnd(35)} ${n.toLocaleString()}`));
  console.log(`\n📦 Categories:`);
  Object.entries(cats).sort((a,b)=>b[1]-a[1]).forEach(([c,n])=>console.log(`   ${c.padEnd(16)} ${n.toLocaleString().padStart(6)} (${pct(n)})`));
  console.log(`\n💰 Price ranges:`);
  Object.entries(priceRanges).sort((a,b)=>b[1]-a[1]).forEach(([r,n])=>console.log(`   ${r.padEnd(10)} ${n.toLocaleString().padStart(6)} (${pct(n)})`));
  console.log(`\n🏪 Top 20 retailers:`);
  Object.entries(retailers).sort((a,b)=>b[1]-a[1]).slice(0,20).forEach(([r,n])=>console.log(`   ${r.padEnd(24)} ${n.toLocaleString().padStart(6)}`));
  console.log(`\n🔗 Offer coverage:`);
  console.log(`   no offers at all    ${noOfferCount.noOffers.toLocaleString().padStart(7)} (${pct(noOfferCount.noOffers)})`);
  console.log(`   offer but no URL    ${noOfferCount.noUrl.toLocaleString().padStart(7)} (${pct(noOfferCount.noUrl)})`);

  // Print 3 sample records as they'd look in Algolia
  console.log(`\n🧪 3 sample Algolia records:`);
  [0, Math.floor(raw.length / 2), raw.length - 1].forEach((i) => {
    const r = toAlgoliaRecord(raw[i]);
    console.log(`\n   [${i}] ${r.title}`);
    console.log(`       brand=${r.brand} | retailer=${r.retailer} | price=$${r.price} (${r.price_range})`);
    console.log(`       category=${r.category} | tags=${r.aesthetic_tags.slice(0,5).join(", ")}`);
    console.log(`       image=${r.image_url.slice(0,70)}...`);
    console.log(`       url=${r.product_url.slice(0,70)}...`);
  });
  console.log("");
}

async function probeApi() {
  console.log("\n🔬 Probing Channel3 API — fetching 1 page of 'dress' and dumping response shape...\n");
  const data = await fetchPage("dress", null, undefined);
  console.log("Top-level keys:", Object.keys(data));
  console.log("products count:", (data.products ?? data.items ?? data.results ?? []).length);
  console.log("Pagination fields:", {
    next_page_token:  data.next_page_token,
    nextPageToken:    data.nextPageToken,
    next_token:       data.next_token,
    cursor:           data.cursor,
    page_info:        data.page_info,
    pagination:       data.pagination,
  });
  if ((data.products ?? [])[0]) {
    console.log("\nFirst product keys:", Object.keys(data.products[0]));
    console.log("First product images[0]:", data.products[0].images?.[0]);
    console.log("First product offers[0]:", data.products[0].offers?.[0]);
  }
  process.exit(0);
}

async function main() {
  if (!CHANNEL3_API_KEY && !UPLOAD_ONLY && !INSPECT) {
    console.error("❌ Missing CHANNEL3_API_KEY. Add it to .env.local and re-run.");
    process.exit(1);
  }

  if (PROBE)   { await probeApi();    return; }
  if (INSPECT) { await inspectCache(); return; }

  let products;

  if (UPLOAD_ONLY) {
    if (!existsSync(CACHE_FILE)) {
      console.error(`❌ No cache file found at ${CACHE_FILE}. Run without --upload-only first.`);
      process.exit(1);
    }
    console.log(`📂 Loading from cache: ${CACHE_FILE}`);
    products = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    console.log(`   ${products.length.toLocaleString()} products loaded`);
  } else {
    products = await fetchAllProducts();

    console.log(`\n💾 Saving ${products.length.toLocaleString()} raw products to ${CACHE_FILE}...`);
    writeFileSync(CACHE_FILE, JSON.stringify(products), "utf8");
    console.log("   Saved.");
  }

  if (!FETCH_ONLY) {
    await uploadToAlgolia(products);
  } else {
    console.log("\n✅ Fetch complete. Run with --upload-only to upload to Algolia.\n");
  }
}

main().catch((err) => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
