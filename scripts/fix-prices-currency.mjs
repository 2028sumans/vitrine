/**
 * Convert non-USD brand prices in Algolia to USD.
 *
 * Background: the scraper reads each Shopify store's native price into Algolia
 * labeled USD. Stores in India / Japan / UAE / Sweden / UK left us with wildly
 * inflated dollar prices (Dhruv Kapoor "lounge pants: $273,600"). This script
 * multiplies price by a fixed FX rate per brand and recomputes price_range.
 *
 * Not idempotent — don't re-run without updating the map. Adds no flag field
 * to products; the only signal a record has been converted is that its price
 * becomes sane.
 *
 * Run:
 *   ALGOLIA_ADMIN_KEY=<key> node scripts/fix-prices-currency.mjs            # dry-run
 *   ALGOLIA_ADMIN_KEY=<key> node scripts/fix-prices-currency.mjs --yes       # apply
 *   ALGOLIA_ADMIN_KEY=<key> node scripts/fix-prices-currency.mjs --brand "X" # single brand
 */
import { algoliasearch } from "algoliasearch";
import fs from "fs";
import path from "path";

const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX_NAME        = "vitrine_products";
if (!ALGOLIA_ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }

const args  = process.argv.slice(2);
const APPLY = args.includes("--yes");
const brandArgIdx = args.indexOf("--brand");
const BRAND_ONLY  = brandArgIdx >= 0 ? args[brandArgIdx + 1] : null;

// ── Currency map ─────────────────────────────────────────────────────────────
// Verified by fetching one product page per brand and grepping the HTML for
// Shopify's declared shop currency. Rates are late-2025-ish, fixed for now;
// rerun with refreshed rates if FX drifts >5% and you care.

const BRAND_CURRENCY = {
  "Dhruv Kapoor":    { currency: "INR", rate: 0.012   },  // 1 USD ≈ 83 INR
  "Momotaro Jeans":  { currency: "JPY", rate: 0.0066  },  // 1 USD ≈ 150 JPY
  "Marmar Halim":    { currency: "AED", rate: 0.272   },  // pegged 3.673 AED = 1 USD
  "Lisa Yang":       { currency: "SEK", rate: 0.093   },  // 1 USD ≈ 10.7 SEK
  "Dima Ayad":       { currency: "AED", rate: 0.272   },
  "Clio Peppiatt":   { currency: "GBP", rate: 1.27    },  // GBP → USD (GBP is stronger)
  "Hissa Line":      { currency: "QAR", rate: 0.275   },  // pegged 3.64 QAR = 1 USD
};

// Bucket thresholds match scripts/scrape-shopify.mjs
function priceRange(price) {
  if (!price)       return "unknown";
  if (price < 50)   return "budget";
  if (price < 150)  return "mid";
  return "luxury";
}

// ── Main ─────────────────────────────────────────────────────────────────────

const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

const brandsToFix = BRAND_ONLY
  ? Object.entries(BRAND_CURRENCY).filter(([b]) => b === BRAND_ONLY)
  : Object.entries(BRAND_CURRENCY);

if (brandsToFix.length === 0) {
  console.error(`No brands matched. Known: ${Object.keys(BRAND_CURRENCY).join(", ")}`);
  process.exit(1);
}

console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`Brands: ${brandsToFix.map(([b]) => b).join(", ")}\n`);

let grandTotal = 0;
let grandUpdated = 0;

for (const [brand, { currency, rate }] of brandsToFix) {
  console.log(`── ${brand} (${currency} → USD @ ${rate}) ────────────────────`);

  const products = [];
  await client.browseObjects({
    indexName: INDEX_NAME,
    browseParams: {
      filters: `brand:"${brand.replace(/"/g, '\\"')}"`,
      hitsPerPage: 1000,
      attributesToRetrieve: ["objectID", "title", "price", "price_range"],
    },
    aggregator: (res) => {
      for (const h of res.hits) {
        if (h.price == null || h.price <= 0) continue;
        products.push(h);
      }
    },
  });

  console.log(`  products with price: ${products.length}`);
  grandTotal += products.length;
  if (products.length === 0) continue;

  // Compute updates
  const updates = products.map((p) => {
    const newPrice = Math.round(p.price * rate);
    const newRange = priceRange(newPrice);
    return {
      objectID:    p.objectID,
      title:       p.title,
      oldPrice:    p.price,
      newPrice,
      oldRange:    p.price_range,
      newRange,
    };
  });

  // Dry-run sample
  const sample = updates.slice(0, 6);
  console.log(`  sample (showing 6 of ${updates.length}):`);
  for (const u of sample) {
    console.log(`    $${u.oldPrice.toString().padStart(7)} → $${u.newPrice.toString().padStart(5)}  [${u.oldRange} → ${u.newRange}]  ${u.title.slice(0, 45)}`);
  }

  if (!APPLY) continue;

  // Apply in batches. partialUpdateObjects accepts { objectID, ...patch }.
  const BATCH = 100;
  let done = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH).map((u) => ({
      objectID:    u.objectID,
      price:       u.newPrice,
      price_range: u.newRange,
    }));
    await client.partialUpdateObjects({ indexName: INDEX_NAME, objects: batch });
    done += batch.length;
    process.stdout.write(`\r  applied ${done}/${updates.length}`);
  }
  process.stdout.write("\n");
  grandUpdated += updates.length;
}

console.log(`\n✓ ${APPLY ? "Updated" : "Would update"} ${grandUpdated.toLocaleString()} / ${grandTotal.toLocaleString()} products`);
if (!APPLY) console.log(`\nRe-run with --yes to apply.`);
