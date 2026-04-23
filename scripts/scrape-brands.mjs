/**
 * Vitrine — targeted brand scraper
 *
 * Scrapes a small, curated list of brands and uploads products to Algolia.
 * Two strategies, picked per-brand:
 *   shopify → GET /products.json (paginated)
 *   html    → walk sitemap.xml → fetch each product page → parse JSON-LD + OG meta
 *
 * Run:
 *   ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/scrape-brands.mjs
 *   ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/scrape-brands.mjs --brand "Khaite"
 *   ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/scrape-brands.mjs --dry-run
 */

import { algoliasearch } from "algoliasearch";
import { writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";

// ── Auto-load .env.local so you don't have to prefix every command ────────────

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, k, raw] = m;
    const v = raw.replace(/^["']|["']$/g, "");
    // Skip malformed values (e.g. the PINECONE_INDEX quirk seen elsewhere)
    if (/[=\s]/.test(v)) continue;
    if (!process.env[k]) process.env[k] = v;
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID;
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX_NAME        = "vitrine_products";
const BATCH_SIZE        = 500;
const SHOPIFY_DELAY_MS  = 600;
const HTML_DELAY_MS     = 250;
const HTML_CONCURRENCY  = 6;
const HTML_URL_CAP      = 2000;
const FETCH_TIMEOUT_MS  = 15000;
const CHECKPOINT_FILE   = "scripts/brands-checkpoint.json";
const LOG_FILE          = "scripts/brands-scrape.log";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const brandFlag = args.includes("--brand") ? args[args.indexOf("--brand") + 1] : null;
const isDryRun  = args.includes("--dry-run");

// ── Brand list ────────────────────────────────────────────────────────────────
// Domains verified live via products.json probe on 2026-04-19.
// "Toterne" in the original request is assumed to mean Totême; change if wrong.
// Arakii's public domain could not be identified — fill in `domain` before running.

const BRANDS = [
  // Shopify (verified via products.json probe)
  { brand: "Tove",            domain: "tove-studio.com",      strategy: "shopify" },
  { brand: "Destree",         domain: "destree.com",          strategy: "shopify" },
  { brand: "St. Agni",        domain: "st-agni.com",          strategy: "shopify" },
  { brand: "Kallmeyer",       domain: "kallmeyer.nyc",        strategy: "shopify" },
  { brand: "Lisa Yang",       domain: "lisa-yang.com",        strategy: "shopify" },
  { brand: "Totême",          domain: "toteme-studio.com",    strategy: "shopify",
    note: "Original request said 'Toterne' — assumed typo for Totême." },
  { brand: "Khaite",          domain: "khaite.com",           strategy: "shopify" },
  { brand: "Róhe",            domain: "roheframes.com",       strategy: "shopify" },
  { brand: "Boyy",            domain: "boyy.com",             strategy: "shopify" },
  { brand: "The Row",         domain: "therow.com",           strategy: "shopify" },
  { brand: "High Sport",      domain: "high-sport.com",       strategy: "shopify" },
  { brand: "Yume Yume",       domain: "yumeyume.eu",          strategy: "shopify" },
  { brand: "Morgane Le Fay",  domain: "morganelefay.com",     strategy: "shopify" },
  { brand: "Cinzia Rocca",    domain: "cinziarocca.com",      strategy: "shopify" },
  { brand: "St. John",        domain: "stjohnknits.com",      strategy: "shopify" },

  // HTML (sitemap + JSON-LD) — non-Shopify or no JSON API
  { brand: "Nour Hammour",    domain: "nour-hammour.com",     strategy: "html" },
  { brand: "Eileen Fisher",   domain: "www.eileenfisher.com", strategy: "html",
    note: "Akamai bot protection — sitemap/HTML fetches may 403; run will no-op gracefully." },
  { brand: "Save the Queen",  domain: "shop.savethequeen.it", strategy: "html",
    note: "Site returns 403 to server-side fetches; may need a headless browser." },

  // Domain not identified — fill in before running.
  // If you know the storefront URL, update `domain` and `strategy` accordingly.
  { brand: "Arakii",          domain: null,                   strategy: "html",
    note: "Public domain not identified." },
  { brand: "Fuzzi",           domain: null,                   strategy: "html",
    note: "Public storefront not identified; fuzzi.it / fuzzi.com did not resolve." },
  { brand: "Piazza Sempione", domain: null,                   strategy: "html",
    note: "Public storefront not identified; piazzasempione.com/.it did not resolve." },
  { brand: "Eksandar",        domain: null,                   strategy: "html",
    note: "Public domain not identified." },
];

// ── Shared helpers ────────────────────────────────────────────────────────────

function parsePrice(str) {
  if (str == null) return null;
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
  dress:  ["dress","jumpsuit","romper","playsuit","gown","bodycon","shift","sundress","minidress","maxi dress","midi dress"],
  top:    ["top","blouse","shirt","tee","tank","cami","camisole","bodysuit","sweater","knit","cardigan","pullover","sweatshirt","hoodie","corset","crop"],
  bottom: ["trouser","pant","skirt","short","jean","denim","legging","culotte","jogger","wide-leg","palazzo","cargo"],
  jacket: ["jacket","blazer","coat","trench","vest","gilet","puffer","anorak","cape","overcoat","bomber","leather jacket"],
  shoes:  ["shoe","boot","sandal","heel","flat","loafer","sneaker","mule","pump","stiletto","wedge","ankle boot","ballet flat","slingback"],
  bag:    ["bag","tote","clutch","handbag","purse","backpack","crossbody","satchel","pouch","wristlet","shoulder bag","mini bag"],
};

function categorize(title) {
  const t = (title || "").toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some((kw) => t.includes(kw))) return cat;
  }
  return "other";
}

const AESTHETIC_MAP = {
  minimalist:  ["minimal","simple","clean","basic","classic","timeless","structured","tailored"],
  bohemian:    ["boho","floral","wrap","maxi","flowy","linen","crochet","embroidered","tiered","peasant"],
  romantic:    ["lace","ruffle","frill","satin","silk","floral","tiered","feminine","bow","ribbon","corset"],
  edgy:        ["leather","asymmetric","cutout","mesh","chain","bold","moto","grunge","fishnet"],
  preppy:      ["plaid","striped","button","collar","polo","tailored","blazer","nautical","gingham"],
  casual:      ["jersey","cotton","relaxed","oversized","everyday","comfort","knit","t-shirt"],
  elegant:     ["satin","silk","velvet","drape","formal","evening","gown","ballgown","sequin"],
  sporty:      ["active","sport","tennis","athletic","stretch","performance","biker"],
  cottagecore: ["floral","ditsy","prairie","puff sleeve","milkmaid","embroidered","gingham","smocked"],
  party:       ["sequin","glitter","metallic","mini","bodycon","cutout","backless","going out"],
  y2k:         ["low rise","baby","denim","butterfly","velour","rhinestone","micro","crop"],
  coastal:     ["linen","stripe","nautical","white","blue","breezy","resort","vacation","sundress"],
};

const COLORS = [
  "black","white","red","blue","green","pink","yellow","orange","purple","brown",
  "beige","cream","navy","burgundy","olive","sage","terracotta","coral","mauve","lilac",
  "rust","camel","chocolate","ivory","gold","silver","leopard","floral","print",
];

function tagAesthetics(text) {
  const t = (text || "").toLowerCase();
  const tags = [];
  for (const [aesthetic, kws] of Object.entries(AESTHETIC_MAP)) {
    if (kws.some((kw) => t.includes(kw))) tags.push(aesthetic);
  }
  for (const color of COLORS) if (t.includes(color)) tags.push(color);
  if (t.includes("mini")) tags.push("mini");
  if (t.includes("midi")) tags.push("midi");
  if (t.includes("maxi")) tags.push("maxi");
  return [...new Set(tags)];
}

const MENS_KEYWORDS = ["men","mens","man","boys","male","unisex"];

function isMensShopify(product) {
  const title = (product.title || "").toLowerCase();
  const tags  = Array.isArray(product.tags)
    ? product.tags.map((t) => t.toLowerCase())
    : (typeof product.tags === "string" ? product.tags.toLowerCase().split(",").map((t) => t.trim()) : []);
  const productType = (product.product_type || "").toLowerCase();
  return MENS_KEYWORDS.some((kw) =>
    title.includes(kw) || productType.includes(kw) || tags.includes(kw),
  );
}

function isMensText(text) {
  const t = (text || "").toLowerCase();
  return MENS_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(t));
}

function domainToPrefix(domain) {
  return (domain || "unknown").replace(/[^a-z0-9]/gi, "");
}

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Some storefronts (notably Shopify) double-escape their JSON-LD so
// URLs come out of JSON.parse still containing literal "\u0026" etc.
function unescapeJsonEscapes(s) {
  if (typeof s !== "string") return s;
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithTimeout(url, init = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return { scrapedBrands: [], products: [] };
  try { return JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8")); }
  catch { return { scrapedBrands: [], products: [] }; }
}

function saveCheckpoint(scrapedBrands, products) {
  try {
    writeFileSync(CHECKPOINT_FILE, JSON.stringify({ scrapedBrands, products }, null, 2));
  } catch (err) {
    log(`  WARN: could not save checkpoint: ${err.message}`);
  }
}

// ── Shopify strategy ──────────────────────────────────────────────────────────

async function fetchShopifyPage(domain, page) {
  try {
    const res = await fetchWithTimeout(
      `https://${domain}/products.json?limit=250&page=${page}`,
      { headers: BROWSER_HEADERS },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.products ?? null;
  } catch { return null; }
}

function normalizeShopifyProduct(product, domain, brand) {
  const title = product.title || "";
  const images = (product.images || [])
    .map((img) => img.src || "")
    .filter((src) => src.startsWith("http") && src.length > 20);
  const image_url = images[0];
  if (!image_url) return null;

  const handle = product.handle;
  if (!handle) return null;
  const product_url = `https://${domain}/products/${handle}`;

  const variants = product.variants || [];
  const rawPrice = variants[0]?.price ?? product.price ?? null;
  const price = parsePrice(rawPrice);

  const colorOption = (product.options || []).find(
    (o) => o.name?.toLowerCase() === "color" || o.name?.toLowerCase() === "colour",
  );
  const color = colorOption?.values?.[0] ?? "";

  const description = (product.body_html || "").replace(/<[^>]+>/g, " ").slice(0, 500);
  const text = `${title} ${description} ${color} ${(product.tags || []).join(" ")}`;

  return {
    objectID:       `shpfy-${domainToPrefix(domain)}-${product.id}`,
    title, brand, price,
    price_range:    priceRange(price),
    color,
    material:       "",
    description,
    image_url,
    images:         images.slice(0, 5),
    product_url,
    retailer:       brand,
    aesthetic_tags: tagAesthetics(text),
    category:       categorize(title),
    scraped_at:     new Date().toISOString(),
  };
}

async function scrapeShopify(brand, domain, { dryRun }) {
  log(`  Shopify → ${domain} (${brand})…`);
  const products = [];
  let page = 1;
  while (true) {
    const raw = await fetchShopifyPage(domain, page);
    if (!raw) {
      if (page === 1) log(`  SKIP ${domain}: fetch failed or non-Shopify response`);
      break;
    }
    if (raw.length === 0) {
      log(`  ${domain}: page ${page} empty, stopping (${products.length} total)`);
      break;
    }
    for (const p of raw) {
      if (isMensShopify(p)) continue;
      const n = normalizeShopifyProduct(p, domain, brand);
      if (n) products.push(n);
    }
    log(`  ${domain}: page ${page} — ${raw.length} raw, ${products.length} kept`);
    if (dryRun) { log(`  DRY RUN: stopping after first page`); break; }
    if (raw.length < 250) break;
    page++;
    await sleep(SHOPIFY_DELAY_MS);
  }
  return products;
}

// ── HTML / JSON-LD strategy ───────────────────────────────────────────────────
// Works on any storefront that publishes a sitemap and embeds schema.org Product
// JSON-LD or standard OpenGraph tags on product pages — i.e. most modern e-com.

async function fetchSitemapUrls(domain) {
  const tried = new Set();
  const queue = [
    `https://${domain}/sitemap.xml`,
    `https://${domain}/sitemap_index.xml`,
    `https://${domain}/sitemap_products_1.xml`,
  ];
  const urls = [];
  while (queue.length && urls.length < HTML_URL_CAP * 3) {
    const sm = queue.shift();
    if (!sm || tried.has(sm)) continue;
    tried.add(sm);
    try {
      const res = await fetchWithTimeout(sm, { headers: BROWSER_HEADERS });
      if (!res.ok) continue;
      const xml = await res.text();
      // Sitemap-index: <sitemap><loc>…</loc></sitemap>
      for (const m of xml.matchAll(/<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>/g)) {
        if (!tried.has(m[1])) queue.push(m[1]);
      }
      // Urlset: <url><loc>…</loc></url>
      for (const m of xml.matchAll(/<url>[\s\S]*?<loc>([^<]+)<\/loc>/g)) urls.push(m[1]);
    } catch {}
  }
  return urls;
}

function isLikelyProductUrl(u) {
  const skip = /\/(collections|category|categories|pages|blogs?|about|contact|search|account|cart|policies)\//i;
  if (skip.test(u)) return false;
  return /\/(product|products|shop|style|item)\//i.test(u);
}

function extractJsonLdProducts(html) {
  const blocks = [...html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )].map((m) => m[1]);
  const out = [];
  for (const b of blocks) {
    let parsed;
    try { parsed = JSON.parse(b.trim()); } catch { continue; }
    const candidates = Array.isArray(parsed)
      ? parsed
      : parsed["@graph"] ? parsed["@graph"] : [parsed];
    for (const c of candidates) {
      const type = c?.["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
      if (isProduct) out.push(c);
    }
  }
  return out;
}

function extractOgMeta(html) {
  const get = (prop) => {
    const m = html.match(
      new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
    );
    return m?.[1];
  };
  return {
    title:       get("og:title"),
    image:       get("og:image"),
    description: get("og:description"),
    price:       get("product:price:amount") || get("og:price:amount"),
  };
}

// Strip Shopify CDN crop / cache-bust query params. og:image and JSON-LD
// `image` on Shopify storefronts both serve a 1200x630 social-card crop
// from the top of the packshot — useless for tall product photography
// because the top sliver is mostly empty white background. Drop the query
// string for cdn.shopify.com URLs so the CDN serves the original instead.
function stripShopifyCrop(src) {
  if (typeof src !== "string" || !src.startsWith("http")) return src;
  if (!src.includes("cdn.shopify.com"))                   return src;
  return src.split("?")[0];
}

function normalizeHtmlProduct(jsonLd, og, url, domain, brand) {
  const title = unescapeJsonEscapes(jsonLd?.name || og.title);
  if (!title) return null;

  let image_url = "";
  if (Array.isArray(jsonLd?.image))          image_url = jsonLd.image[0];
  else if (typeof jsonLd?.image === "string") image_url = jsonLd.image;
  else if (jsonLd?.image?.url)                image_url = jsonLd.image.url;
  image_url = stripShopifyCrop(unescapeJsonEscapes(image_url || og.image || ""));
  if (!image_url || !image_url.startsWith("http")) return null;

  const offers = Array.isArray(jsonLd?.offers) ? jsonLd.offers[0] : jsonLd?.offers;
  const rawPrice = offers?.price ?? offers?.lowPrice ?? og.price ?? null;
  const price = parsePrice(rawPrice);

  const description = unescapeJsonEscapes(
    String(jsonLd?.description || og.description || "").slice(0, 500),
  );
  const color    = typeof jsonLd?.color    === "string" ? unescapeJsonEscapes(jsonLd.color)    : "";
  const material = typeof jsonLd?.material === "string" ? unescapeJsonEscapes(jsonLd.material) : "";
  const ldCategory = typeof jsonLd?.category === "string" ? jsonLd.category : "";
  const text = `${title} ${description} ${color} ${ldCategory}`;
  if (isMensText(text)) return null;

  const images = [image_url];
  if (Array.isArray(jsonLd?.image)) {
    for (const u of jsonLd.image.slice(0, 4)) {
      if (typeof u !== "string") continue;
      const clean = stripShopifyCrop(unescapeJsonEscapes(u));
      if (!images.includes(clean)) images.push(clean);
    }
  }

  const id = jsonLd?.sku || jsonLd?.productID || slugify(title);
  const titleCat = categorize(title);
  const category = titleCat !== "other" ? titleCat
                 : ldCategory ? slugify(ldCategory) : "other";

  return {
    objectID:       `html-${domainToPrefix(domain)}-${slugify(String(id))}`.slice(0, 120),
    title, brand, price,
    price_range:    priceRange(price),
    color, material, description,
    image_url,
    images:         images.slice(0, 5),
    product_url:    url,
    retailer:       brand,
    aesthetic_tags: tagAesthetics(text),
    category,
    scraped_at:     new Date().toISOString(),
  };
}

async function scrapeProductHtml(url, domain, brand) {
  try {
    const res = await fetchWithTimeout(url, { headers: BROWSER_HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const jsonLd = extractJsonLdProducts(html)[0] || null;
    const og = extractOgMeta(html);
    if (!jsonLd && !og.title) return null;
    return normalizeHtmlProduct(jsonLd, og, url, domain, brand);
  } catch { return null; }
}

async function scrapeHtml(brand, domain, { dryRun }) {
  if (!domain) { log(`  SKIP ${brand}: no domain configured`); return []; }
  log(`  HTML → ${domain} (${brand})…`);

  let urls = (await fetchSitemapUrls(domain)).filter(isLikelyProductUrl);
  log(`  ${domain}: sitemap yielded ${urls.length} likely product URLs`);
  if (urls.length === 0) return [];

  if (urls.length > HTML_URL_CAP) {
    log(`  ${domain}: capping to first ${HTML_URL_CAP} URLs`);
    urls = urls.slice(0, HTML_URL_CAP);
  }
  if (dryRun) {
    urls = urls.slice(0, 5);
    log(`  DRY RUN: ${urls.length} URLs`);
  }

  const products = [];
  for (let i = 0; i < urls.length; i += HTML_CONCURRENCY) {
    const chunk = urls.slice(i, i + HTML_CONCURRENCY);
    const results = await Promise.all(chunk.map((u) => scrapeProductHtml(u, domain, brand)));
    for (const r of results) if (r) products.push(r);
    if (((i / HTML_CONCURRENCY) | 0) % 10 === 0) {
      log(`  ${domain}: ${Math.min(i + HTML_CONCURRENCY, urls.length)}/${urls.length} fetched, ${products.length} kept`);
    }
    await sleep(HTML_DELAY_MS);
  }
  return products;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_KEY) {
    console.error(
      "Missing ALGOLIA_APP_ID or ALGOLIA_ADMIN_KEY\n" +
      "Run: ALGOLIA_APP_ID=xxx ALGOLIA_ADMIN_KEY=xxx node scripts/scrape-brands.mjs",
    );
    process.exit(1);
  }
  try { appendFileSync(LOG_FILE, `\n===== Run started ${new Date().toISOString()} =====\n`); } catch {}

  let targets = BRANDS;
  if (brandFlag) {
    const match = BRANDS.find((b) => b.brand.toLowerCase() === brandFlag.toLowerCase());
    if (!match) {
      log(`Brand "${brandFlag}" not in list. Choices: ${BRANDS.map((b) => b.brand).join(", ")}`);
      process.exit(1);
    }
    targets = [match];
  }

  const checkpoint = loadCheckpoint();
  const done = new Set(checkpoint.scrapedBrands || []);
  let all = checkpoint.products || [];
  if (done.size) log(`Resuming: ${done.size} brands already done, ${all.length} products cached`);

  for (const { brand, domain, strategy, note } of targets) {
    if (done.has(brand)) { log(`SKIP ${brand}: already in checkpoint`); continue; }
    if (note) log(`  NOTE (${brand}): ${note}`);
    let products = [];
    try {
      if (strategy === "shopify")    products = await scrapeShopify(brand, domain, { dryRun: isDryRun });
      else if (strategy === "html")  products = await scrapeHtml(brand, domain, { dryRun: isDryRun });
    } catch (err) {
      log(`  ERROR ${brand}: ${err.message}`);
    }
    all = all.concat(products);
    done.add(brand);
    log(`  ${brand}: ${products.length} products (running total: ${all.length})`);
    saveCheckpoint([...done], all);
  }

  // Dedup by objectID
  const seen = new Set();
  const deduped = all.filter((p) => {
    if (seen.has(p.objectID)) return false;
    seen.add(p.objectID);
    return true;
  });
  log(`\nAfter dedup: ${deduped.length} unique products`);

  if (isDryRun) { log("DRY RUN: skipping Algolia upload."); return; }

  log("\nConnecting to Algolia…");
  const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);
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

  const counts = {};
  for (const p of deduped) counts[p.brand] = (counts[p.brand] || 0) + 1;
  log("\nBreakdown by brand:");
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([b, n]) => log(`  ${b}: ${n}`));
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
