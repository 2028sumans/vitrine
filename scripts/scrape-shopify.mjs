/**
 * Vitrine — Shopify product scraper
 * Scrapes womenswear Shopify stores and uploads products to Algolia.
 *
 * Run:
 *   ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/scrape-shopify.mjs
 *   ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/scrape-shopify.mjs --domain majorelle.com
 *   ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/scrape-shopify.mjs --dry-run
 */

import { algoliasearch } from "algoliasearch";
import { writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";

// ── Config ────────────────────────────────────────────────────────────────────

const ALGOLIA_APP_ID  = process.env.ALGOLIA_APP_ID;
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX_NAME      = "vitrine_products";
const BATCH_SIZE      = 500;
const CHECKPOINT_SIZE = 200;
const PAGE_DELAY_MS   = 600;
const CHECKPOINT_FILE = "scripts/shopify-checkpoint.json";
const LOG_FILE        = "scripts/shopify-scrape-log.txt";

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args        = process.argv.slice(2);
const domainFlag  = args.includes("--domain") ? args[args.indexOf("--domain") + 1] : null;
const isDryRun    = args.includes("--dry-run");

// ── Brand domains ─────────────────────────────────────────────────────────────

const ALL_BRAND_DOMAINS = [
  { domain: "majorelle.com",           brand: "Majorelle" },
  { domain: "retrofete.com",           brand: "Retrofete" },
  { domain: "wayf.com",               brand: "WAYF" },
  { domain: "loverandfriends.com",     brand: "Lover and Friends" },
  { domain: "wearnbd.com",             brand: "NBD" },
  { domain: "shopmumu.com",            brand: "Mumu" },
  { domain: "lspaceswim.com",          brand: "L*Space" },
  { domain: "houseofharlow1960.com",   brand: "House of Harlow 1960" },
  { domain: "rails.com",              brand: "Rails" },
  { domain: "astrthelabel.com",        brand: "ASTR the Label" },
  { domain: "bardotfashion.com",       brand: "Bardot" },
  { domain: "significantotherlabel.com", brand: "Significant Other" },
  { domain: "forloveandlemons.com",    brand: "For Love & Lemons" },
  { domain: "farmrio.com",             brand: "Farm Rio" },
  { domain: "cultgaia.com",            brand: "Cult Gaia" },
  { domain: "lacademie.com",           brand: "L'Academie" },
  { domain: "staud.clothing",          brand: "STAUD" },
  { domain: "thesleeper.co",           brand: "The Sleeper" },
  { domain: "rotate1991.com",          brand: "Rotate" },
  { domain: "nanushka.com",            brand: "Nanushka" },
  { domain: "saylornyc.com",           brand: "Saylor" },
  { domain: "manningcartell.com",      brand: "Manning Cartell" },
  { domain: "ajeworld.com",            brand: "Aje" },
  { domain: "elliattonline.com",       brand: "elliatt" },
  { domain: "shonajoy.com",            brand: "Shona Joy" },
  { domain: "sir-thelabel.com",        brand: "Sir. The Label" },
  { domain: "becandbridge.com",        brand: "Bec + Bridge" },
  { domain: "finders-keepers.com",     brand: "Finders Keepers" },
  { domain: "theeastorder.com",        brand: "The East Order" },
  { domain: "atoir.com.au",            brand: "Atoir" },
  { domain: "hansenandgretel.com",     brand: "Hansen & Gretel" },
  { domain: "cleobella.com",           brand: "Cleobella" },
  { domain: "spelldesigns.com",        brand: "Spell" },
  { domain: "faithfulltbrand.com",     brand: "Faithfull the Brand" },
  { domain: "oakandfort.com",          brand: "Oak + Fort" },
  { domain: "wildfox.com",             brand: "Wildfox" },
  { domain: "tularosaclothing.com",    brand: "Tularosa" },
  { domain: "likelylabel.com",         brand: "Likely" },
  { domain: "caminycollection.com",    brand: "Caminy Collection" },
  { domain: "lalignenyc.com",          brand: "L'aligne" },
  { domain: "veronicam.com",           brand: "Veronica M" },
  { domain: "ronnykobo.com",           brand: "Ronny Kobo" },
  { domain: "byticket.com",            brand: "By Ticket" },
  { domain: "sabo-skirt.com",          brand: "Sabo Skirt" },
  { domain: "lulus.com",              brand: "Lulus" },
  { domain: "showpo.com",              brand: "Showpo" },
  { domain: "tigermist.com",           brand: "Tiger Mist" },
  { domain: "beginning-boutique.com",  brand: "Beginning Boutique" },
  { domain: "petal-and-pup.com",       brand: "Petal & Pup" },
  { domain: "iamgia.com",              brand: "I AM GIA" },
  { domain: "dissh.com",              brand: "Dissh" },
  { domain: "lioness-fashion.com",     brand: "Lioness" },
  { domain: "winona.com.au",           brand: "Winona" },
  { domain: "by-dyln.com",             brand: "By Dyln" },
  { domain: "johnnywas.com",           brand: "Johnny Was" },
  { domain: "rixo.co.uk",              brand: "RIXO" },
  { domain: "alicemccall.com.au",      brand: "Alice McCall" },
  { domain: "thurleyonline.com",       brand: "Thurley" },
  { domain: "realisation-par.com",     brand: "Realisation Par" },
  { domain: "loveshackfancy.com",      brand: "LoveShackFancy" },
  { domain: "aninebing.com",           brand: "Anine Bing" },
  { domain: "moussycollection.com",    brand: "Moussy" },
  { domain: "grlfrnd.com",             brand: "GRLFRND" },
  { domain: "agolde.com",              brand: "AGOLDE" },
  { domain: "currentelliott.com",      brand: "Current/Elliott" },
  { domain: "motherdenim.com",         brand: "Mother Denim" },
  { domain: "drdenim.com",             brand: "Dr Denim" },
  { domain: "nili-lotan.com",          brand: "Nili Lotan" },
  { domain: "jenni-kayne.com",         brand: "Jenni Kayne" },
  { domain: "hunza-g.com",             brand: "Hunza G" },
  { domain: "tropic-of-c.com",         brand: "Tropic of C" },
  { domain: "solid-and-striped.com",   brand: "Solid & Striped" },
  { domain: "tavik.com",              brand: "Tavik" },
  { domain: "mikohstore.com",          brand: "Miko H" },
  { domain: "cleobella.com",           brand: "Cleobella" },
  { domain: "ghost.co.uk",             brand: "Ghost" },
  { domain: "macgraw.com.au",          brand: "Macgraw" },
  { domain: "camilla.com",             brand: "Camilla" },
  { domain: "talulah.com.au",          brand: "Talulah" },
  { domain: "witchery.com",            brand: "Witchery" },
  { domain: "forever21.com",           brand: "Forever 21" },
  { domain: "paige.com",              brand: "Paige" },
  { domain: "seafolly.com",            brand: "Seafolly" },
  { domain: "ryanroche.com",           brand: "Ryan Roche" },
  { domain: "jet-swimwear.com.au",     brand: "Jets Swimwear" },
];

// ── Utilities (same as upload-to-algolia.mjs) ─────────────────────────────────

function parsePrice(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

function priceRange(price) {
  if (!price) return "unknown";
  if (price < 50)  return "budget";
  if (price < 150) return "mid";
  return "luxury";
}

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
    if (keywords.some((kw) => t.includes(kw))) return cat;
  }
  return "other";
}

const AESTHETIC_MAP = {
  minimalist:  ["minimal", "simple", "clean", "basic", "classic", "timeless", "structured", "tailored"],
  bohemian:    ["boho", "floral", "wrap", "maxi", "flowy", "linen", "crochet", "embroidered", "tiered", "peasant"],
  romantic:    ["lace", "ruffle", "frill", "satin", "silk", "floral", "tiered", "feminine", "bow", "ribbon", "corset"],
  edgy:        ["leather", "asymmetric", "cutout", "mesh", "chain", "bold", "moto", "grunge", "fishnet"],
  preppy:      ["plaid", "striped", "button", "collar", "polo", "tailored", "blazer", "nautical", "gingham"],
  casual:      ["jersey", "cotton", "relaxed", "oversized", "everyday", "comfort", "knit", "t-shirt"],
  elegant:     ["satin", "silk", "velvet", "drape", "formal", "evening", "gown", "ballgown", "sequin"],
  sporty:      ["active", "sport", "tennis", "athletic", "stretch", "performance", "biker"],
  cottagecore: ["floral", "ditsy", "prairie", "puff sleeve", "milkmaid", "embroidered", "gingham", "smocked"],
  party:       ["sequin", "glitter", "metallic", "mini", "bodycon", "cutout", "backless", "going out"],
  y2k:         ["low rise", "baby", "denim", "butterfly", "velour", "rhinestone", "micro", "crop"],
  coastal:     ["linen", "stripe", "nautical", "white", "blue", "breezy", "resort", "vacation", "sundress"],
};

const COLORS = ["black","white","red","blue","green","pink","yellow","orange","purple","brown",
  "beige","cream","navy","burgundy","olive","sage","terracotta","coral","mauve","lilac",
  "rust","camel","chocolate","ivory","gold","silver","leopard","floral","print"];

function tagAesthetics(text) {
  const t = (text || "").toLowerCase();
  const tags = [];
  for (const [aesthetic, kws] of Object.entries(AESTHETIC_MAP)) {
    if (kws.some((kw) => t.includes(kw))) tags.push(aesthetic);
  }
  for (const color of COLORS) {
    if (t.includes(color)) tags.push(color);
  }
  if (t.includes("mini")) tags.push("mini");
  if (t.includes("midi")) tags.push("midi");
  if (t.includes("maxi")) tags.push("maxi");
  return [...new Set(tags)];
}

// ── Mens filter ───────────────────────────────────────────────────────────────

const MENS_KEYWORDS = ["men", "mens", "man", "boys", "male", "unisex"];

function isMensProduct(product) {
  const title = (product.title || "").toLowerCase();
  const tags  = Array.isArray(product.tags)
    ? product.tags.map((t) => t.toLowerCase())
    : (typeof product.tags === "string" ? product.tags.toLowerCase().split(",").map((t) => t.trim()) : []);
  const productType = (product.product_type || "").toLowerCase();

  return MENS_KEYWORDS.some((kw) =>
    title.includes(kw) || productType.includes(kw) || tags.includes(kw)
  );
}

// ── Domain → safe objectID prefix ────────────────────────────────────────────

function domainToPrefix(domain) {
  return domain.replace(/\./g, "");
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return { scrapedDomains: [], products: [] };
  try {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8"));
  } catch {
    return { scrapedDomains: [], products: [] };
  }
}

function saveCheckpoint(scrapedDomains, products) {
  try {
    writeFileSync(CHECKPOINT_FILE, JSON.stringify({ scrapedDomains, products }, null, 2));
  } catch (err) {
    log(`  WARN: Could not save checkpoint: ${err.message}`);
  }
}

// ── Page fetch ────────────────────────────────────────────────────────────────

async function fetchPage(domain, page) {
  const url = `https://${domain}/products.json?limit=250&page=${page}`;
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Vitrine/1.0; +https://vitrine.fashion)" },
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const json = await res.json();
    return json.products ?? null;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

// ── Normalize product ─────────────────────────────────────────────────────────

function normalizeProduct(product, domain, brand) {
  const title = product.title || "";

  // Extract first valid image
  const images = (product.images || [])
    .map((img) => img.src || "")
    .filter((src) => src.startsWith("http") && src.length > 20);

  const image_url = images[0] ?? "";
  if (!image_url) return null;

  // Build product URL
  const handle = product.handle || "";
  if (!handle) return null;
  const product_url = `https://${domain}/products/${handle}`;

  // Price from first variant
  const variants = product.variants || [];
  const rawPrice = variants[0]?.price ?? product.price ?? null;
  const price = parsePrice(rawPrice);

  // Price range: products with variant prices spanning ranges — use first variant
  const allPrices = variants.map((v) => parsePrice(v.price)).filter((p) => p !== null);
  let price_range_val = priceRange(price);

  // Color: from option named "Color" or "Colour"
  const colorOption = (product.options || []).find(
    (o) => o.name?.toLowerCase() === "color" || o.name?.toLowerCase() === "colour"
  );
  const color = colorOption?.values?.[0] ?? "";

  // Material: from body_html or tags
  const description = (product.body_html || "").replace(/<[^>]+>/g, " ").slice(0, 500);

  const text = `${title} ${description} ${color} ${(product.tags || []).join(" ")}`;

  const objectID = `shpfy-${domainToPrefix(domain)}-${product.id}`;

  return {
    objectID,
    title,
    brand,
    price,
    price_range: price_range_val,
    color,
    material: "",
    description,
    image_url,
    images: images.slice(0, 5),
    product_url,
    retailer: brand,
    aesthetic_tags: tagAesthetics(text),
    category: categorize(title),
    scraped_at: new Date().toISOString(),
  };
}

// ── Scrape one domain ─────────────────────────────────────────────────────────

async function scrapeDomain(domain, brand, { dryRun = false } = {}) {
  log(`  Scraping ${domain} (${brand})…`);
  const products = [];
  let page = 1;

  while (true) {
    const raw = await fetchPage(domain, page);

    if (!raw) {
      if (page === 1) {
        log(`  SKIP ${domain}: fetch failed or non-Shopify response`);
      } else {
        log(`  ${domain}: page ${page} returned null, stopping`);
      }
      break;
    }

    if (raw.length === 0) {
      log(`  ${domain}: page ${page} empty, stopping (${products.length} total)`);
      break;
    }

    for (const rawProduct of raw) {
      // Skip mens products
      if (isMensProduct(rawProduct)) continue;

      const normalized = normalizeProduct(rawProduct, domain, brand);
      if (!normalized) continue;

      products.push(normalized);
    }

    log(`  ${domain}: page ${page} — ${raw.length} raw, ${products.length} kept`);

    if (dryRun) {
      log(`  DRY RUN: stopping after first page`);
      break;
    }

    if (raw.length < 250) break; // last page

    page++;
    // Polite delay
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }

  return products;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_KEY) {
    console.error("Missing ALGOLIA_APP_ID or ALGOLIA_ADMIN_KEY\n" +
      "Run: ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/scrape-shopify.mjs");
    process.exit(1);
  }

  // Initialize log file
  try {
    appendFileSync(LOG_FILE, `\n===== Run started ${new Date().toISOString()} =====\n`);
  } catch {}

  // Determine which domains to scrape
  let brandDomains = ALL_BRAND_DOMAINS;

  if (domainFlag) {
    const match = ALL_BRAND_DOMAINS.find((b) => b.domain === domainFlag);
    if (!match) {
      // Allow ad-hoc domains not in the list
      brandDomains = [{ domain: domainFlag, brand: domainFlag }];
      log(`Domain ${domainFlag} not in known list — scraping with domain as brand name`);
    } else {
      brandDomains = [match];
    }
  } else if (isDryRun) {
    brandDomains = ALL_BRAND_DOMAINS.slice(0, 3);
    log("DRY RUN: only first 3 domains, first page only");
  }

  // Load checkpoint
  const checkpoint = loadCheckpoint();
  const scrapedDomains = new Set(checkpoint.scrapedDomains || []);
  let allProducts = checkpoint.products || [];

  if (scrapedDomains.size > 0) {
    log(`Resuming from checkpoint: ${scrapedDomains.size} domains already done, ${allProducts.length} products cached`);
  }

  // Scrape each domain
  let productsSinceLastCheckpoint = 0;

  for (const { domain, brand } of brandDomains) {
    if (scrapedDomains.has(domain)) {
      log(`SKIP ${domain}: already in checkpoint`);
      continue;
    }

    try {
      const domainProducts = await scrapeDomain(domain, brand, { dryRun: isDryRun });
      allProducts = allProducts.concat(domainProducts);
      scrapedDomains.add(domain);
      productsSinceLastCheckpoint += domainProducts.length;
      log(`  ${domain}: ${domainProducts.length} products (total: ${allProducts.length})`);

      // Save checkpoint every CHECKPOINT_SIZE products
      if (productsSinceLastCheckpoint >= CHECKPOINT_SIZE) {
        saveCheckpoint([...scrapedDomains], allProducts);
        log(`  Checkpoint saved (${allProducts.length} products, ${scrapedDomains.size} domains done)`);
        productsSinceLastCheckpoint = 0;
      }
    } catch (err) {
      log(`  ERROR ${domain}: ${err.message} — skipping`);
    }
  }

  // Final checkpoint
  saveCheckpoint([...scrapedDomains], allProducts);
  log(`\nAll domains scraped. Total products: ${allProducts.length}`);

  // Dedup by objectID
  const seen = new Set();
  const deduped = allProducts.filter((p) => {
    if (seen.has(p.objectID)) return false;
    seen.add(p.objectID);
    return true;
  });
  log(`After dedup: ${deduped.length} unique products`);

  // Upload to Algolia
  log("\nConnecting to Algolia…");
  const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

  log(`Uploading in batches of ${BATCH_SIZE}…`);
  let uploaded = 0;
  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);
    try {
      await client.saveObjects({ indexName: INDEX_NAME, objects: batch });
      uploaded += batch.length;
      log(`  Uploaded ${uploaded}/${deduped.length}`);
    } catch (err) {
      log(`  ERROR uploading batch at ${i}: ${err.message}`);
    }
  }

  log(`\nDone! ${uploaded} products uploaded to "${INDEX_NAME}"`);

  // Breakdown by brand
  const counts = {};
  deduped.forEach((p) => { counts[p.brand] = (counts[p.brand] || 0) + 1; });
  log("\nBreakdown by brand:");
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([brand, count]) => log(`  ${brand}: ${count}`));
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
