/**
 * Fix Nour Hammour image URLs in Algolia.
 *
 * scrape-brands.mjs reads images from JSON-LD / og:image, which Shopify
 * serves as a 1200x630 social-card crop from the top of the packshot.
 * For tall portrait product photos, that crop is mostly white background.
 *
 * Strip the ?width=1200&height=630&crop=top query params (and the cache-bust
 * ?v=…) so the CDN serves the full original image instead. Then ask the
 * Pinecone re-embed step to refresh the 197 affected vectors.
 *
 * Run:
 *   node scripts/fix-nour-hammour-images.mjs --dry-run
 *   ALGOLIA_ADMIN_KEY=… node scripts/fix-nour-hammour-images.mjs --yes
 */

import { algoliasearch } from "algoliasearch";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const ALGOLIA_APP_ID    = process.env.ALGOLIA_APP_ID ?? "BSDU5QFOT3";
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX_NAME        = "vitrine_products";

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes("--dry-run");
const AUTO_YES = args.includes("--yes");

if (!ALGOLIA_ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }

// Shopify CDN crop params we want to strip. Match either the explicit
// ?width=&height=&crop=top combo or the catch-all `?` query string — for
// these packshots there's never a meaningful query, just cache-bust + crop.
function clean(url) {
  if (typeof url !== "string" || !url.startsWith("http")) return url;
  if (!url.includes("cdn.shopify.com")) return url;  // only Shopify CDN
  return url.split("?")[0];
}

async function main() {
  const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

  console.log("Scanning vitrine_products for Nour Hammour records with cropped images…");
  const toFix = [];
  await client.browseObjects({
    indexName: INDEX_NAME,
    browseParams: {
      query: "",
      hitsPerPage: 1000,
      filters: 'brand:"Nour Hammour"',
      attributesToRetrieve: ["objectID", "image_url", "images"],
    },
    aggregator: (r) => {
      for (const h of r.hits) {
        const url = h.image_url || "";
        const needs = url.includes("crop=top") || url.includes("width=1200");
        if (!needs) continue;
        const newImageUrl = clean(url);
        const newImages   = Array.isArray(h.images) ? h.images.map(clean) : undefined;
        // Only patch if something actually changed (defensive).
        if (newImageUrl === url && JSON.stringify(newImages) === JSON.stringify(h.images)) continue;
        toFix.push({
          objectID: h.objectID,
          image_url: newImageUrl,
          ...(newImages ? { images: newImages } : {}),
        });
      }
    },
  });

  console.log(`Found ${toFix.length} records to fix.`);
  if (toFix.length === 0) return;

  // Save the list of affected objectIDs so the re-embed step can target only
  // these products instead of the whole catalog.
  writeFileSync(
    "scripts/nour-hammour-fixed-ids.json",
    JSON.stringify(toFix.map((r) => r.objectID), null, 2),
  );
  console.log("Wrote scripts/nour-hammour-fixed-ids.json");

  console.log("\nSample changes:");
  for (const r of toFix.slice(0, 3)) {
    console.log(`  ${r.objectID}`);
    console.log(`    → ${r.image_url}`);
  }

  if (DRY_RUN) { console.log("\n--dry-run: not pushing to Algolia."); return; }

  console.log(`\nPushing partial updates to Algolia (${toFix.length} records)…`);
  // partialUpdateObjects upserts only the fields we send — leaves title,
  // price, etc. untouched.
  const BATCH = 500;
  let done = 0;
  for (let i = 0; i < toFix.length; i += BATCH) {
    const chunk = toFix.slice(i, i + BATCH);
    await client.partialUpdateObjects({ indexName: INDEX_NAME, objects: chunk });
    done += chunk.length;
    process.stdout.write(`\r  updated ${done}/${toFix.length}`);
  }
  console.log(`\n✓ Updated ${done} records in Algolia.`);
  console.log("\nNext: run scripts/reembed-from-ids.mjs to refresh Pinecone vectors.");
}

main().catch((e) => { console.error(e); process.exit(1); });
