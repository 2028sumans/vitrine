// Same verifier as test-other-shopify.mjs but against thegoodtrade-brands.txt
import { readFileSync, writeFileSync } from "fs";

const BRANDS_FILE = "scripts/thegoodtrade-brands.txt";
const OUT_FILE    = "scripts/thegoodtrade-shopify-verified.json";
const TIMEOUT_MS  = 7000;
const CONCURRENCY = 20;

const scraperSrc = readFileSync("scripts/scrape-shopify.mjs", "utf8");
const existingDomains = new Set();
for (const m of scraperSrc.matchAll(/domain:\s*"([^"]+)"/g)) existingDomains.add(m[1]);
console.log(`${existingDomains.size} domains already in scraper (will skip).`);

function slugify(name, mode="concat") {
  let s = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.split("|")[0];
  s = s.replace(/\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, "");
  s = s.toLowerCase().replace(/&/g, "and").replace(/[.,'’!?®™"]/g, "");
  s = s.replace(/[^a-z0-9\s+-]/g, "").trim().replace(/\s+/g, mode === "dash" ? "-" : "");
  return s.replace(/^-+|-+$/g, "");
}
function candidates(name) {
  const c = slugify(name,"concat"), d = slugify(name,"dash");
  const strip = (s) => s.replace(/(the|studios?|collection|official|store|label|clothing|fashion)$/i, "");
  const bases = [...new Set([c,d,strip(c),strip(d),c.replace(/-/g,""),"shop"+c,"the"+c,"wear"+c])].filter(s => s && s.length >= 3 && s.length <= 45);
  const tlds = [".com",".co",".shop",".co.uk",".com.au",".store",".net",".us"];
  return [...new Set(bases.flatMap(b => tlds.map(t => b+t)))];
}
async function fetchT(url, ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" }}); }
  catch { return null; }
  finally { clearTimeout(to); }
}
async function testDomain(domain) {
  if (existingDomains.has(domain)) return { domain, skipped: true };
  const res = await fetchT(`https://${domain}/products.json?limit=1`, TIMEOUT_MS);
  if (!res || res.status !== 200) return null;
  try {
    const txt = await res.text();
    if (!txt.includes('"products"')) return null;
    const d = JSON.parse(txt);
    if (!Array.isArray(d.products) || d.products.length === 0) return null;
    return { domain };
  } catch { return null; }
}
async function find(name) {
  for (const dom of candidates(name)) {
    const r = await testDomain(dom);
    if (r && !r.skipped) return r;
  }
  return null;
}
const brands = readFileSync(BRANDS_FILE,"utf8").split("\n").map(s=>s.trim()).filter(Boolean);
console.log(`Testing ${brands.length} brands...\n`);
let done = 0;
const verified = [];
async function worker() {
  while (true) {
    const name = brands.shift(); if (!name) return;
    const hit = await find(name);
    done++;
    if (hit) { verified.push({brand:name,domain:hit.domain}); process.stdout.write(`\r[${done}] ✓ ${name} → ${hit.domain}${" ".repeat(20)}\n`); }
    else if (done % 5 === 0) process.stdout.write(`\r[${done}] (${verified.length} verified)`);
  }
}
await Promise.all(Array.from({length: CONCURRENCY}, worker));
console.log(`\n\nDone. ${verified.length} verified.`);
verified.sort((a,b)=>a.brand.localeCompare(b.brand));
writeFileSync(OUT_FILE, JSON.stringify(verified, null, 2));
console.log(`Saved to ${OUT_FILE}`);
