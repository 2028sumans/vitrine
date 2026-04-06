/**
 * Vitrine — Multi-retailer product upload to Algolia
 * Handles: ASOS, Bloomingdale's, Edikted, Hello Molly, Nordstrom, Revolve (x2)
 *
 * Run:
 *   ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/upload-to-algolia.mjs
 */

import { createReadStream } from "fs";
import readline from "readline";
import { algoliasearch } from "algoliasearch";

// ── Config ────────────────────────────────────────────────────────────────────

const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID;
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX_NAME = "vitrine_products";

const FILES = [
  {
    path: "/Users/2028sumans/iCloud Drive (Archive)/Desktop/asos-com-2026-01-18.csv",
    retailer: "ASOS",
    parser: "asos",
  },
  {
    path: "/Users/2028sumans/Desktop/bloomingdales-com-2026-01-22.csv",
    retailer: "Bloomingdale's",
    parser: "bloomingdales",
  },
  {
    path: "/Users/2028sumans/iCloud Drive (Archive)/Desktop/edikted-com-2026-01-19.csv",
    retailer: "Edikted",
    parser: "edikted",
  },
  {
    path: "/Users/2028sumans/iCloud Drive (Archive)/Desktop/hellomolly-com-2026-01-19.csv",
    retailer: "Hello Molly",
    parser: "hellomolly",
  },
  {
    path: "/Users/2028sumans/iCloud Drive (Archive)/Desktop/nordstrom-com-2026-01-19.csv",
    retailer: "Nordstrom",
    parser: "nordstrom",
  },
  {
    path: "/Users/2028sumans/iCloud Drive (Archive)/Desktop/revolve-com-2026-01-18-2.csv",
    retailer: "Revolve",
    parser: "revolve1",
  },
  {
    path: "/Users/2028sumans/Desktop/revolve-com-2026-02-18-4.csv",
    retailer: "Revolve",
    parser: "revolve2",
  },
];

// ── Utilities ─────────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === "," && !inQuotes) { result.push(current.trim()); current = ""; }
    else { current += char; }
  }
  result.push(current.trim());
  return result;
}

function parsePrice(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

function priceRange(price) {
  if (!price) return "unknown";
  if (price < 50) return "budget";
  if (price < 150) return "mid";
  return "luxury";
}

function extractImages(str) {
  if (!str) return [];
  return str.split("\n").map(u => u.trim()).filter(u => u.startsWith("http")).slice(0, 5);
}

function slug(str, i) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) + `-${i}`;
}

// ── Category classification ───────────────────────────────────────────────────

const CATEGORY_KEYWORDS = {
  dress:   ["dress", "jumpsuit", "romper", "playsuit", "gown", "bodycon", "shift", "sundress", "minidress", "maxi dress", "midi dress"],
  top:     ["top", "blouse", "shirt", "tee", "tank", "cami", "camisole", "bodysuit", "sweater", "knit", "cardigan", "pullover", "sweatshirt", "hoodie", "corset", "crop"],
  bottom:  ["trouser", "pant", "skirt", "short", "jean", "denim", "legging", "culotte", "jogger", "wide-leg", "palazzo", "cargo"],
  jacket:  ["jacket", "blazer", "coat", "trench", "vest", "gilet", "puffer", "anorak", "cape", "overcoat", "bomber", "leather jacket"],
  shoes:   ["shoe", "boot", "sandal", "heel", "flat", "loafer", "sneaker", "mule", "pump", "stiletto", "wedge", "ankle boot", "ballet flat", "slingback"],
  bag:     ["bag", "tote", "clutch", "handbag", "purse", "backpack", "crossbody", "satchel", "pouch", "wristlet", "shoulder bag", "mini bag"],
};

function categorize(title) {
  const t = (title || "").toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => t.includes(kw))) return cat;
  }
  return "other";
}

// ── Aesthetic tagging ─────────────────────────────────────────────────────────

const AESTHETIC_MAP = {
  minimalist:   ["minimal", "simple", "clean", "basic", "classic", "timeless", "structured", "tailored"],
  bohemian:     ["boho", "floral", "wrap", "maxi", "flowy", "linen", "crochet", "embroidered", "tiered", "peasant"],
  romantic:     ["lace", "ruffle", "frill", "satin", "silk", "floral", "tiered", "feminine", "bow", "ribbon", "corset"],
  edgy:         ["leather", "asymmetric", "cutout", "mesh", "chain", "bold", "moto", "grunge", "fishnet"],
  preppy:       ["plaid", "striped", "button", "collar", "polo", "tailored", "blazer", "nautical", "gingham"],
  casual:       ["jersey", "cotton", "relaxed", "oversized", "everyday", "comfort", "knit", "t-shirt"],
  elegant:      ["satin", "silk", "velvet", "drape", "formal", "evening", "gown", "ballgown", "sequin"],
  sporty:       ["active", "sport", "tennis", "athletic", "stretch", "performance", "biker"],
  cottagecore:  ["floral", "ditsy", "prairie", "puff sleeve", "milkmaid", "embroidered", "gingham", "smocked"],
  party:        ["sequin", "glitter", "metallic", "mini", "bodycon", "cutout", "backless", "going out"],
  y2k:          ["low rise", "baby", "denim", "butterfly", "velour", "rhinestone", "micro", "crop"],
  coastal:      ["linen", "stripe", "nautical", "white", "blue", "breezy", "resort", "vacation", "sundress"],
};

const COLORS = ["black","white","red","blue","green","pink","yellow","orange","purple","brown",
  "beige","cream","navy","burgundy","olive","sage","terracotta","coral","mauve","lilac",
  "rust","camel","chocolate","ivory","gold","silver","leopard","floral","print"];

function aestheticTags(text) {
  const t = text.toLowerCase();
  const tags = [];
  for (const [aesthetic, kws] of Object.entries(AESTHETIC_MAP)) {
    if (kws.some(kw => t.includes(kw))) tags.push(aesthetic);
  }
  for (const color of COLORS) {
    if (t.includes(color)) tags.push(color);
  }
  if (t.includes("mini")) tags.push("mini");
  if (t.includes("midi")) tags.push("midi");
  if (t.includes("maxi")) tags.push("maxi");
  return [...new Set(tags)];
}

// ── Per-retailer parsers ───────────────────────────────────────────────────────

const PARSERS = {
  asos: (row, i) => {
    const title = row["name_0"] || row["name_1"] || "";
    const price = parsePrice(row["price_0"]);
    const images = extractImages(row["image_15"] || row["image_14"] || row["image_0"] || "");
    return {
      objectID: row["sku_0"] || `asos-${i}`,
      title,
      brand: row["name_1"] || "ASOS",
      price,
      color: (row["color_0"] || "").replace("COLOR:", "").trim(),
      material: row["product_material_0"] || "",
      description: (row["description_0"] || "").slice(0, 500),
      image_url: images[0] || "",
      images,
      product_url: row["data-page-selector"] || "",
    };
  },

  bloomingdales: (row, i) => {
    const title = row["product_name_0"] || row["name_0"] || "";
    const price = parsePrice(row["price_1"] || row["price_0"]);
    const images = extractImages(row["image_0"] || row["image_1"] || "");
    return {
      objectID: `bloomingdales-${i}`,
      title,
      brand: row["brand_0"] || row["name_1"] || "Bloomingdale's",
      price,
      color: (row["color_0"] || "").replace("Color:", "").trim(),
      material: row["materials_care_0"] || "",
      description: (row["features_0"] || "").slice(0, 500),
      image_url: images[0] || "",
      images,
      product_url: row["data-page-selector"] || "",
    };
  },

  edikted: (row, i) => {
    const title = row["data_0"] || "";
    const price = parsePrice(row["price_0"]);
    const images = extractImages(row["image_0"] || "");
    return {
      objectID: `edikted-${i}`,
      title,
      brand: "Edikted",
      price,
      color: row["options_values_0"] || "",
      material: "",
      description: (row["description_0"] || "").slice(0, 500),
      image_url: images[0] || "",
      images,
      product_url: row["data-page-selector"] || "",
    };
  },

  hellomolly: (row, i) => {
    const title = row["data_1"] || row["name_1"] || "";
    const price = parsePrice(row["data_0"]);
    const images = extractImages(row["image_0"] || "");
    return {
      objectID: `hellomolly-${i}`,
      title,
      brand: "Hello Molly",
      price,
      color: "",
      material: "",
      description: (row["product_description_0"] || row["description_0"] || "").slice(0, 500),
      image_url: images[0] || "",
      images,
      product_url: row["data-page-selector"] || "",
    };
  },

  nordstrom: (row, i) => {
    const title = row["name_6"] || row["name_0"] || "";
    const price = parsePrice(row["price_0"] || row["text_9"]);
    const images = extractImages(row["image_0"] || "");
    return {
      objectID: `nordstrom-${i}`,
      title,
      brand: row["name_0"] || row["stores_amenities_name_9"] || "Nordstrom",
      price,
      color: row["Color_0"] || "",
      material: "",
      description: (row["description_0"] || "").slice(0, 500),
      image_url: images[0] || "",
      images,
      product_url: row["data-page-selector"] || "",
    };
  },

  revolve1: (row, i) => {
    const title = row["data_0"] || row["name_0"] || "";
    const price = parsePrice(row["price_0"]);
    const images = extractImages(row["image_0"] || "");
    return {
      objectID: `revolve1-${i}`,
      title,
      brand: row["name_1"] || "Revolve",
      price,
      color: row["color_0"] || "",
      material: (row["description_1"] || "").slice(0, 200),
      description: (row["description_0"] || row["about_the_brand_0"] || "").slice(0, 500),
      image_url: images[0] || "",
      images,
      product_url: row["data-page-selector"] || "",
    };
  },

  revolve2: (row, i) => {
    const title = row["name"] || row["data"] || "";
    const price = parsePrice(row["price"] || row["price2"] || row["price3"]);
    const images = extractImages([row["image"], row["image2"], row["image3"], row["image4"],
      row["image5"], row["image6"], row["image7"], row["image8"], row["image9"], row["image10"]]
      .filter(Boolean).join("\n"));
    return {
      objectID: `revolve2-${i}`,
      title,
      brand: row["brand"] || "Revolve",
      price,
      color: "",
      material: "",
      description: (row["data2"] || row["data4"] || "").slice(0, 500),
      image_url: images[0] || "",
      images,
      product_url: row["data-page-selector"] || row["web_scraper_start_url"] || "",
    };
  },
};

// ── CSV reader ────────────────────────────────────────────────────────────────

async function readCSV(filePath, parserName, retailer) {
  const records = [];
  let headers = null;
  let lineNum = 0;
  let skipped = 0;

  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const parse = PARSERS[parserName];

  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);

    if (lineNum === 1) {
      headers = cols.map(h => h.replace(/^\uFEFF/, "").trim());
      continue;
    }

    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });

    try {
      const base = parse(row, lineNum);
      if (!base.title || !base.product_url) { skipped++; continue; }

      const text = `${base.title} ${base.description} ${base.color} ${base.material}`;
      const record = {
        ...base,
        retailer,
        price_range:    priceRange(base.price),
        aesthetic_tags: aestheticTags(text),
        category:       categorize(base.title),
      };
      records.push(record);
    } catch {
      skipped++;
    }
  }

  console.log(`  ✅ ${retailer}: ${records.length} products (${skipped} skipped)`);
  return records;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_KEY) {
    console.error("❌ Missing ALGOLIA_APP_ID or ALGOLIA_ADMIN_KEY\n" +
      "Run: ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/upload-to-algolia.mjs");
    process.exit(1);
  }

  console.log("📂 Parsing all retailer files...\n");
  let allRecords = [];

  for (const file of FILES) {
    const records = await readCSV(file.path, file.parser, file.retailer);
    allRecords = allRecords.concat(records);
  }

  console.log(`\n📦 Total: ${allRecords.length} products across all retailers`);

  // Deduplicate by title+retailer
  const seen = new Set();
  allRecords = allRecords.filter(r => {
    const key = `${r.retailer}:${r.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`🧹 After dedup: ${allRecords.length} unique products`);

  console.log("\n🔌 Connecting to Algolia...");
  const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

  await client.setSettings({
    indexName: INDEX_NAME,
    indexSettings: {
      searchableAttributes: ["title", "brand", "description", "color", "material", "aesthetic_tags", "retailer"],
      attributesForFaceting: [
        "filterOnly(aesthetic_tags)",
        "filterOnly(retailer)",
        "filterOnly(brand)",
        "filterOnly(price_range)",
        "filterOnly(category)",
      ],
      customRanking: ["desc(price)"],
    },
  });

  console.log("⬆️  Uploading in batches of 1000...");
  const batchSize = 1000;
  for (let i = 0; i < allRecords.length; i += batchSize) {
    const batch = allRecords.slice(i, i + batchSize);
    await client.saveObjects({ indexName: INDEX_NAME, objects: batch });
    process.stdout.write(`\r   ${Math.min(i + batchSize, allRecords.length)}/${allRecords.length}`);
  }

  console.log(`\n\n🎉 Done! ${allRecords.length} products uploaded to index "${INDEX_NAME}"`);
  console.log("\n📊 Breakdown by retailer:");
  const counts = {};
  allRecords.forEach(r => { counts[r.retailer] = (counts[r.retailer] || 0) + 1; });
  Object.entries(counts).forEach(([retailer, count]) => console.log(`   ${retailer}: ${count}`));
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
