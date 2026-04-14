/**
 * Test which SSQRD brands expose a Shopify /products.json endpoint.
 *
 * Reads scripts/ssqrd-brands.txt (one brand per line), guesses multiple
 * domain candidates per brand, tests each, and writes verified Shopify
 * domains to scripts/ssqrd-shopify-verified.json.
 *
 * Run: node scripts/test-ssqrd-shopify.mjs
 */

import { readFileSync, writeFileSync } from "fs";

const BRANDS_FILE = "scripts/ssqrd-brands.txt";
const OUT_FILE    = "scripts/ssqrd-shopify-verified.json";
const TIMEOUT_MS  = 7000;
const CONCURRENCY = 20;

// Skip beauty / skincare / non-apparel brands (we only want fashion)
const SKIP_KEYWORDS = [
  "beauty", "skin", "skincare", "cosmetic", "fragrance", "candle",
  "press", "marketplace", "eyewear", "botanicals", "soap", "jewels",
  "jewelry only",
];

// Brands we already have (from prior verified list — skip retesting)
const ALREADY_HAVE = new Set([
  "12pm Studios", "1xblue", "4tothe9", "6ixth November", "Adanola",
  "A.emery", "Alemais", "Aligne", "Almada Label", "Alohas",
  "Andrea Iyamah", "Ance Gria", "Amaya García", "Ameera Hammouda",
  "Alas Eius", "Alejandra Alonso Rojas", "Abayasbyfilsan",
  "Ahankarwear", "Amyshehab", "Adrian Cashmere", "Shrimpton Couture",
  "No Standing NYC", "2nd Street USA", "Fashionphile",
]);

function slugify(name, mode = "concat") {
  // Strip diacritics
  let s = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Remove anything after | (e.g. "Archies Footwear | Usa" -> "Archies Footwear")
  s = s.split("|")[0];
  // Remove parenthesized bits
  s = s.replace(/\([^)]*\)/g, "");
  // Remove quoted/bracketed extra text
  s = s.replace(/\[[^\]]*\]/g, "");
  // Lowercase
  s = s.toLowerCase();
  // Replace & with and
  s = s.replace(/&/g, "and");
  // Strip punctuation
  s = s.replace(/[.,'’!?®™"]/g, "");
  // Strip non-ASCII (for lowercase latin-only domain)
  s = s.replace(/[^a-z0-9\s+-]/g, "");
  // Collapse whitespace
  s = s.trim().replace(/\s+/g, mode === "dash" ? "-" : "");
  // Remove trailing hyphens
  s = s.replace(/^-+|-+$/g, "");
  return s;
}

function candidateDomains(name) {
  const concat = slugify(name, "concat");
  const dashed = slugify(name, "dash");
  // Also try stripped "the/studios" suffix variants
  const stripSuffix = (s) => s.replace(/(the|studios?|collection|official|store|label)$/i, "");

  const bases = [...new Set([
    concat,
    dashed,
    stripSuffix(concat),
    stripSuffix(dashed),
    concat.replace(/-/g, ""),
  ])].filter(Boolean).filter(s => s.length >= 3);

  const tlds = [".com", ".co", ".shop", ".co.uk", ".com.au", ".store", ".net", ".nyc"];
  const out = [];
  for (const base of bases) {
    for (const tld of tlds) out.push(base + tld);
  }
  // Dedup
  return [...new Set(out)];
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const to   = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ShopifyBrandCheck/1.0)" },
    });
    return res;
  } catch { return null; }
  finally { clearTimeout(to); }
}

async function testDomain(domain) {
  const url = `https://${domain}/products.json?limit=1`;
  const res = await fetchWithTimeout(url, TIMEOUT_MS);
  if (!res || res.status !== 200) return null;
  try {
    const text = await res.text();
    // Must look like valid JSON with a products array
    if (!text.includes('"products"')) return null;
    const data = JSON.parse(text);
    if (!Array.isArray(data.products)) return null;
    if (data.products.length === 0) return null;
    return { domain, productsVisible: data.products.length };
  } catch { return null; }
}

async function findWorkingDomain(name) {
  const candidates = candidateDomains(name);
  for (const domain of candidates) {
    const result = await testDomain(domain);
    if (result) return result;
  }
  return null;
}

// Run a fixed concurrency pool
async function runPool(items, worker, concurrency) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      const out = await worker(items[idx], idx);
      results[idx] = out;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return results;
}

async function main() {
  const brands = readFileSync(BRANDS_FILE, "utf8")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  console.log(`Loaded ${brands.length} brands.`);

  // Filter
  const toTest = brands.filter(b => {
    if (ALREADY_HAVE.has(b)) return false;
    const low = b.toLowerCase();
    if (SKIP_KEYWORDS.some(kw => low.includes(kw))) return false;
    return true;
  });
  console.log(`Testing ${toTest.length} brands (${brands.length - toTest.length} skipped).\n`);

  let done = 0;
  const verified = [];

  const results = await runPool(toTest, async (name) => {
    const hit = await findWorkingDomain(name);
    done++;
    if (hit) {
      verified.push({ brand: name, domain: hit.domain });
      process.stdout.write(`\r[${done}/${toTest.length}] ✓ ${name} → ${hit.domain}${" ".repeat(20)}\n`);
    } else if (done % 10 === 0) {
      process.stdout.write(`\r[${done}/${toTest.length}] (${verified.length} verified so far)`);
    }
    return hit;
  }, CONCURRENCY);

  console.log(`\n\nDone. ${verified.length} verified Shopify stores out of ${toTest.length} tested.`);

  // Write output sorted by brand name
  verified.sort((a, b) => a.brand.localeCompare(b.brand));
  writeFileSync(OUT_FILE, JSON.stringify(verified, null, 2));
  console.log(`Saved to ${OUT_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
