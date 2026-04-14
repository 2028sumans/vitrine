/**
 * Same tester as test-ssqrd-shopify.mjs, but against scripts/other-brands.txt.
 * Writes verified stores to scripts/other-shopify-verified.json.
 *
 * Run: node scripts/test-other-shopify.mjs
 */

import { readFileSync, writeFileSync } from "fs";

const BRANDS_FILE = "scripts/other-brands.txt";
const OUT_FILE    = "scripts/other-shopify-verified.json";
const TIMEOUT_MS  = 7000;
const CONCURRENCY = 20;

// Load the current scraper file to know which domains we already have.
// Skip brands whose guessed domain already exists.
const scraperSrc = readFileSync("scripts/scrape-shopify.mjs", "utf8");
const existingDomains = new Set();
for (const m of scraperSrc.matchAll(/domain:\s*"([^"]+)"/g)) existingDomains.add(m[1]);
console.log(`${existingDomains.size} domains already in scraper (will skip).`);

function slugify(name, mode = "concat") {
  let s = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.split("|")[0];
  s = s.replace(/\([^)]*\)/g, "");
  s = s.replace(/\[[^\]]*\]/g, "");
  s = s.toLowerCase();
  s = s.replace(/&/g, "and");
  s = s.replace(/[.,'’!?®™"]/g, "");
  s = s.replace(/[^a-z0-9\s+-]/g, "");
  s = s.trim().replace(/\s+/g, mode === "dash" ? "-" : "");
  s = s.replace(/^-+|-+$/g, "");
  return s;
}

function candidateDomains(name) {
  const concat = slugify(name, "concat");
  const dashed = slugify(name, "dash");
  const stripSuffix = (s) => s.replace(/(the|studios?|collection|official|store|label|clothing|fashion)$/i, "");

  const bases = [...new Set([
    concat,
    dashed,
    stripSuffix(concat),
    stripSuffix(dashed),
    concat.replace(/-/g, ""),
    // Try with "shop" prefix
    "shop" + concat,
    "the" + concat,
  ])].filter(Boolean).filter(s => s.length >= 3 && s.length <= 40);

  const tlds = [".com", ".co", ".shop", ".co.uk", ".com.au", ".store", ".net"];
  const out = [];
  for (const base of bases) {
    for (const tld of tlds) out.push(base + tld);
  }
  return [...new Set(out)];
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const to   = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ShopifyBrandCheck/1.0)" },
    });
    return res;
  } catch { return null; }
  finally { clearTimeout(to); }
}

async function testDomain(domain) {
  if (existingDomains.has(domain)) return { domain, skipped: "already-in-scraper" };
  const url = `https://${domain}/products.json?limit=1`;
  const res = await fetchWithTimeout(url, TIMEOUT_MS);
  if (!res || res.status !== 200) return null;
  try {
    const text = await res.text();
    if (!text.includes('"products"')) return null;
    const data = JSON.parse(text);
    if (!Array.isArray(data.products) || data.products.length === 0) return null;
    return { domain, productsVisible: data.products.length };
  } catch { return null; }
}

async function findWorkingDomain(name) {
  for (const domain of candidateDomains(name)) {
    const result = await testDomain(domain);
    if (result && !result.skipped) return result;
  }
  return null;
}

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
  const brands = readFileSync(BRANDS_FILE, "utf8").split("\n").map(s => s.trim()).filter(Boolean);
  console.log(`Testing ${brands.length} brands...\n`);

  let done = 0;
  const verified = [];

  await runPool(brands, async (name) => {
    const hit = await findWorkingDomain(name);
    done++;
    if (hit) {
      verified.push({ brand: name, domain: hit.domain });
      process.stdout.write(`\r[${done}/${brands.length}] ✓ ${name} → ${hit.domain}${" ".repeat(20)}\n`);
    } else if (done % 10 === 0) {
      process.stdout.write(`\r[${done}/${brands.length}] (${verified.length} verified so far)`);
    }
    return hit;
  }, CONCURRENCY);

  console.log(`\n\nDone. ${verified.length} verified Shopify stores out of ${brands.length}.`);
  verified.sort((a, b) => a.brand.localeCompare(b.brand));
  writeFileSync(OUT_FILE, JSON.stringify(verified, null, 2));
  console.log(`Saved to ${OUT_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
