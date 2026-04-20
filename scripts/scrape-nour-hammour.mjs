/**
 * Vitrine — Nour Hammour scraper.
 *
 * Nour Hammour runs on Shopify Hydrogen (Oxygen-hosted) which does NOT expose
 * the classic /products.json endpoint our scrape-shopify.mjs relies on.
 * Instead we go through:
 *   1. sitemap.xml  → list of every /products/<handle> URL
 *   2. product page → JSON-LD Product block gives name, description, offers
 *                     (price + variants + availability), image[], brand
 *
 * The emitted records match scrape-shopify.mjs exactly so the downstream
 * embed + Algolia pipeline in scripts/embed-with-qc.mjs consumes them
 * without changes.
 *
 * Run:
 *   node scripts/scrape-nour-hammour.mjs --dry-run           # just write JSON, no Algolia
 *   node scripts/scrape-nour-hammour.mjs --limit 10          # sample the first 10 products
 *   ALGOLIA_ADMIN_KEY=... node scripts/scrape-nour-hammour.mjs --yes
 *                                                            # push to Algolia
 */

import { algoliasearch } from "algoliasearch";
import { writeFileSync } from "fs";
import readline from "readline";

// ── Config ────────────────────────────────────────────────────────────────────

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX_NAME        = "vitrine_products";

const DOMAIN            = "nour-hammour.com";
const BRAND             = "Nour Hammour";
const SITEMAP_URL       = `https://${DOMAIN}/sitemap.xml`;
const OUTPUT_FILE       = "scripts/nour-hammour-products.json";

const CONCURRENCY       = 6;
const REQUEST_TIMEOUT   = 20_000;
const USER_AGENT        = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (Vitrine/1.0)";

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes("--dry-run");
const AUTO_YES = args.includes("--yes");
const limitArg = args.find((a) => a.startsWith("--limit"));
const LIMIT    = (() => {
  if (!limitArg) return Infinity;
  const next = args[args.indexOf(limitArg) + 1];
  const n = parseInt(limitArg.includes("=") ? limitArg.split("=")[1] : next, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

// ── Non-apparel handle filter ─────────────────────────────────────────────────
// Their catalog mixes care products (balm, spray, brush…) and gift cards in
// with the leather jackets. Drop those by handle keyword — category detection
// would bucket them as "other" anyway.
const SKIP_HANDLE_KEYWORDS = [
  "balm", "corrector", "protector", "brush", "mist", "spray", "cream",
  "gift-card", "giftcard", "care-kit", "swatch", "sample",
];

function shouldSkipHandle(handle) {
  const h = handle.toLowerCase();
  return SKIP_HANDLE_KEYWORDS.some((kw) => h.includes(kw));
}

// ── Helpers (kept in sync with scrape-shopify.mjs) ────────────────────────────

function parsePrice(str) {
  if (str == null) return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function priceRange(price) {
  if (price == null) return "unknown";
  if (price < 50)  return "budget";
  if (price < 150) return "mid";
  return "luxury";
}

// Order matters — we return on first match. Jacket terms are checked before
// `top` so "Cropped Jacket" isn't sucked into the `top` bucket via the "crop"
// keyword. Same logic for the other categories.
const CATEGORY_KEYWORDS = {
  jacket:  ["jacket", "blazer", "coat", "trench", "vest", "gilet", "puffer", "anorak", "cape", "overcoat", "bomber"],
  dress:   ["dress", "jumpsuit", "romper", "playsuit", "gown", "bodycon", "shift", "sundress"],
  bottom:  ["trouser", "pant", "skirt", "short", "jean", "denim", "legging", "culotte", "jogger", "palazzo", "cargo"],
  top:     ["top", "blouse", "shirt", "tee", "tank", "cami", "camisole", "bodysuit", "sweater", "knit", "cardigan", "pullover", "sweatshirt", "hoodie", "corset", "crop"],
  shoes:   ["shoe", "boot", "sandal", "heel", "flat", "loafer", "sneaker", "mule", "pump", "stiletto", "wedge"],
  bag:     ["bag", "tote", "clutch", "handbag", "purse", "backpack", "crossbody", "satchel", "pouch", "wristlet"],
};

function categorize(title, description = "") {
  // Try the title first (highest-signal), fall back to the description.
  // Nour Hammour product names are proper nouns like "Hatti" or "Dakota"
  // that carry no category keyword — but their descriptions always say
  // "jacket", "coat", "trench" etc. so description fallback is reliable.
  const t = (title || "").toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => t.includes(kw))) return cat;
  }
  const d = (description || "").toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => d.includes(kw))) return cat;
  }
  return "other";
}

const AESTHETIC_MAP = {
  minimalist: ["minimal", "simple", "clean", "classic", "timeless", "structured", "tailored"],
  romantic:   ["lace", "ruffle", "frill", "satin", "silk", "floral", "feminine", "bow", "ribbon"],
  edgy:       ["leather", "moto", "biker", "asymmetric", "cutout", "mesh", "chain", "grunge"],
  preppy:     ["plaid", "striped", "blazer", "nautical", "gingham"],
  casual:     ["relaxed", "oversized", "everyday", "knit"],
  elegant:    ["silk", "velvet", "drape", "formal", "evening", "gown"],
  cottagecore:["prairie", "puff sleeve", "milkmaid", "smocked"],
  party:      ["sequin", "glitter", "metallic", "bodycon", "backless"],
};

const COLORS = [
  "black", "white", "red", "blue", "green", "pink", "yellow", "orange", "purple",
  "brown", "beige", "cream", "navy", "burgundy", "olive", "sage", "terracotta",
  "coral", "mauve", "lilac", "rust", "camel", "chocolate", "ivory", "gold", "silver",
  "leopard", "floral", "milk chocolate", "taupe", "grey", "gray", "tan",
];

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

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}

// ── Fetch with timeout + UA ────────────────────────────────────────────────────

async function fetchText(url) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal:   ctrl.signal,
      redirect: "follow",
      headers:  { "User-Agent": USER_AGENT, "Accept": "text/html,application/xml" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── Step 1: enumerate product URLs from sitemap ───────────────────────────────

async function listProductHandles() {
  const xml = await fetchText(SITEMAP_URL);
  if (!xml) throw new Error(`Failed to fetch ${SITEMAP_URL}`);
  const out = [];
  const seen = new Set();
  const re = /<loc>\s*([^<\s]+\/products\/[^<\s]+?)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const url = m[1];
    const handle = url.split("/products/")[1]?.split(/[?#]/)[0];
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    if (shouldSkipHandle(handle)) continue;
    out.push(handle);
  }
  return out;
}

// ── Step 2: parse Product JSON-LD out of a product page HTML ──────────────────

function extractJsonLdProduct(html) {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates) {
        if (c?.["@type"] === "Product") return c;
      }
    } catch {
      // skip malformed blocks
    }
  }
  return null;
}

// Shopify's Hydrogen storefront double-escapes & as `\u0026` inside the
// JSON-LD script tags, so after JSON.parse the URL still contains literal
// `\u0026` sequences. Undo that before any querystring parsing.
function unescapeUnicodeBackslash(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Extract the Color= query values from all offer URLs so we know which colors
// this product actually ships in. First one we see is the "primary" color.
function extractOfferColors(offers) {
  const seen = new Set();
  const ordered = [];
  for (const o of offers ?? []) {
    const url = unescapeUnicodeBackslash(o?.url ?? "");
    const m = url.match(/[?&]Color=([^&#]+)/i);
    if (!m) continue;
    const color = decodeURIComponent(m[1].replace(/\+/g, " ")).trim();
    const key = color.toLowerCase();
    if (!seen.has(key)) { seen.add(key); ordered.push(color); }
  }
  return ordered;
}

// Trim Shopify's CDN params — we want the full-resolution image, not the 1200x630
// social-card crop that JSON-LD injects for open-graph metadata.
function cleanImageUrl(src) {
  if (typeof src !== "string") return "";
  const fixed = src.replace(/\\u0026/g, "&");
  return fixed.split("?")[0];
}

// ── Normalize one product page into a Vitrine record ──────────────────────────

async function scrapeHandle(handle) {
  const url = `https://${DOMAIN}/us-en/products/${handle}`;
  const html = await fetchText(url);
  if (!html) return { error: "fetch-failed", handle };

  const prod = extractJsonLdProduct(html);
  if (!prod) return { error: "no-json-ld", handle };

  const title = typeof prod.name === "string" ? prod.name.trim() : "";
  if (!title) return { error: "no-title", handle };

  const images = Array.isArray(prod.image) ? prod.image.map(cleanImageUrl).filter(Boolean) : [];
  const image_url = images[0] ?? "";
  if (!image_url) return { error: "no-image", handle };

  const offers = Array.isArray(prod.offers) ? prod.offers : (prod.offers ? [prod.offers] : []);
  const prices = offers.map((o) => parsePrice(o?.price)).filter((p) => p != null);
  const price  = prices[0] ?? null;

  const colors  = extractOfferColors(offers);
  const primary = colors[0] ?? "";

  const description = typeof prod.description === "string" ? prod.description.slice(0, 500) : "";

  // Pull every color-specific variant URL so handle + color-slug uniquely
  // identifies each colorway in the catalog. That lets us surface "Hatti
  // Black" and "Hatti Milk Chocolate" as two separate products downstream.
  const records = [];
  const colorsToEmit = colors.length > 0 ? colors : [""];
  for (const color of colorsToEmit) {
    const colorSlug = color.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const objectID  = colorSlug
      ? `shpfy-${DOMAIN.replace(/\./g, "")}-${handle}-${colorSlug}`
      : `shpfy-${DOMAIN.replace(/\./g, "")}-${handle}`;
    const titleWithColor = color && !title.toLowerCase().includes(color.toLowerCase())
      ? `${title} — ${color}`
      : title;
    const productUrl = color
      ? `${url}?Color=${encodeURIComponent(color)}`
      : url;
    const text = `${titleWithColor} ${description} ${color}`;

    records.push({
      objectID,
      title:          titleWithColor,
      brand:          BRAND,
      price,
      price_range:    priceRange(price),
      color:          color || primary,
      material:       "",
      description,
      image_url,
      images:         images.slice(0, 5),
      product_url:    productUrl,
      retailer:       BRAND,
      aesthetic_tags: tagAesthetics(text),
      category:       categorize(title, description),
      scraped_at:     new Date().toISOString(),
    });
  }
  return { records };
}

// ── Bounded concurrency pool ──────────────────────────────────────────────────

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Nour Hammour scraper — target: ${DOMAIN}\n`);

  console.log("1. Enumerating product URLs from sitemap…");
  const handles = await listProductHandles();
  const target  = handles.slice(0, LIMIT);
  console.log(`   ${handles.length} products total, scraping ${target.length}\n`);

  if (target.length === 0) {
    console.log("Nothing to scrape.");
    return;
  }

  console.log(`2. Fetching ${target.length} product pages (concurrency=${CONCURRENCY})…`);
  const t0 = Date.now();
  let fetched = 0;
  const allRecords = [];
  const errors = [];

  await runPool(target, async (handle) => {
    const out = await scrapeHandle(handle);
    fetched++;
    if (out.error) {
      errors.push({ handle, reason: out.error });
    } else {
      allRecords.push(...out.records);
    }
    process.stdout.write(`\r   ${fetched}/${target.length} fetched  (${allRecords.length} records, ${errors.length} errors)`);
  }, CONCURRENCY);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n   Done in ${elapsed}s.\n`);

  // Category breakdown
  const byCat = {};
  for (const r of allRecords) byCat[r.category] = (byCat[r.category] ?? 0) + 1;
  console.log("3. Records summary:");
  console.log(`   Total:       ${allRecords.length}`);
  for (const [cat, n] of Object.entries(byCat).sort((a,b)=>b[1]-a[1])) {
    console.log(`   ${cat.padEnd(12)} ${n.toString().padStart(5)}`);
  }
  if (errors.length > 0) {
    console.log(`\n   Errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log(`     ${e.reason.padEnd(14)} ${e.handle}`);
    if (errors.length > 10) console.log(`     (+${errors.length - 10} more)`);
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify({ scrapedAt: new Date().toISOString(), domain: DOMAIN, brand: BRAND, products: allRecords, errors }, null, 2));
  console.log(`\n   Wrote ${OUTPUT_FILE}`);

  if (DRY_RUN) {
    console.log("\n--dry-run: skipping Algolia upload.");
    return;
  }

  if (!ALGOLIA_ADMIN_KEY) {
    console.log("\nALGOLIA_ADMIN_KEY not set — skipping upload. Re-run with the env var to push to Algolia.");
    return;
  }

  if (!AUTO_YES) {
    const a = await ask(`\nUpload ${allRecords.length} records to Algolia index "${INDEX_NAME}"? Type "yes": `);
    if (a.trim().toLowerCase() !== "yes") { console.log("Cancelled."); return; }
  }

  console.log(`\n4. Uploading to Algolia index "${INDEX_NAME}"…`);
  const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);
  const BATCH  = 500;
  let saved = 0;
  for (let i = 0; i < allRecords.length; i += BATCH) {
    const chunk = allRecords.slice(i, i + BATCH);
    await client.saveObjects({ indexName: INDEX_NAME, objects: chunk });
    saved += chunk.length;
    process.stdout.write(`\r   saved ${saved}/${allRecords.length}`);
  }
  console.log(`\n\n✓ Uploaded ${saved} records.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
