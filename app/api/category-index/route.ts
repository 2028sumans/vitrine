/**
 * GET /api/category-index
 *
 * Returns a sample product image per display category for the /shop
 * category-picker grid. One Algolia search per category, run in parallel.
 * Cached for an hour — the sample image can rotate occasionally but
 * doesn't need to be fresh on every visit.
 *
 * Data quality guard: the Algolia catalog has some mis-tagged rows (a
 * Momotaro hoodie with category="shoes", etc.). We over-fetch a pool
 * per category and walk until the first hit whose title matches the
 * category's expected vocabulary — that way the card hero never ends
 * up as a hoodie under Shoes or a vintage couture archive piece under
 * Dresses, even when Algolia ranks those items first.
 */

import { NextResponse }  from "next/server";
import { algoliasearch } from "algoliasearch";

export const revalidate = 300; // 5 minutes — short so fixes to the hero
                               // picks propagate fast without a redeploy.

const INDEX_NAME = "vitrine_products";

const CORE_CATS = ["dress", "top", "bottom", "jacket", "shoes", "bag"] as const;

type CategoryRequest = {
  label:    string;
  filters:  string | null;
  query:    string;
};

// Same mapping as app/api/shop-all/route.ts. Kept in sync manually — the two
// lanes need to agree on what each display label means.
//
// `query` biases which single hit Algolia picks for the card hero image.
// The TITLE_WHITELIST below still filters afterward, so the query is a
// ranking nudge, not a hard requirement.
//
// Shoes deliberately has filters=null: Algolia's category:"shoes" index is
// heavily mis-tagged (a Momotaro hoodie with category="shoes" keeps winning
// the pool), so instead we search the whole catalog by keyword and rely on
// the TITLE_WHITELIST below to reject anything whose title isn't a shoe.
const CATEGORIES: CategoryRequest[] = [
  { label: "Tops",                 filters: 'category:"top"',    query: "" },
  { label: "Dresses",              filters: 'category:"dress"',  query: "midi slip linen silk flowy modern" },
  { label: "Bottoms",              filters: 'category:"bottom"', query: "" },
  { label: "Knits",                filters: null,                query: "knit sweater cardigan cashmere wool" },
  { label: "Bags and accessories", filters: 'category:"bag"',    query: "" },
  { label: "Shoes",                filters: null,                query: "heel boot sandal sneaker loafer pump mule espadrille oxford slide" },
  { label: "Outerwear",            filters: 'category:"jacket"', query: "" },
  { label: "Other",                filters: CORE_CATS.map((c) => `NOT category:"${c}"`).join(" AND "), query: "" },
];

// Per-category required title vocabulary. A hit is only picked as the hero
// if its title matches at least one of these words (word-start boundary, so
// "heel" matches "heel"/"heels" but NOT "loopwheel"). If no hit in the pool
// matches, we fall back to the first hit with any valid image URL.
const TITLE_WHITELIST: Record<string, readonly string[]> = {
  "Shoes":                ["heel", "boot", "sandal", "sneaker", "loafer", "pump", "mule", "shoe", "slipper", "espadrille", "oxford", "moccasin", "derby", "clog", "slide"],
  "Dresses":              ["dress", "gown", "slip", "midi", "maxi", "sundress"],
  "Tops":                 ["top", "shirt", "blouse", "tee", "tank", "cami", "bodice", "halter", "bustier"],
  "Bottoms":              ["pant", "skirt", "jean", "trouser", "legging", "short", "culotte"],
  "Outerwear":            ["jacket", "coat", "blazer", "trench", "parka", "puffer", "peacoat", "bomber", "cape"],
  "Bags and accessories": ["bag", "tote", "clutch", "purse", "handbag", "backpack", "satchel", "crossbody"],
  "Knits":                ["knit", "sweater", "cardigan", "cashmere", "wool", "jumper", "pullover", "turtleneck"],
};

// Avoid archive/vintage couture as the hero for a category — those pieces
// photograph dated on a modern product card. Applied on top of the positive
// whitelist.
const TITLE_BLACKLIST: Record<string, readonly string[]> = {
  "Dresses": ["haute", "couture", "archive"],
};

function titleOk(label: string, title: string): boolean {
  const t = title.toLowerCase();
  const allow = TITLE_WHITELIST[label];
  if (allow && !allow.some((k) => new RegExp(`\\b${k}`, "i").test(t))) return false;
  const block = TITLE_BLACKLIST[label];
  if (block && block.some((k) => new RegExp(`\\b${k}`, "i").test(t))) return false;
  return true;
}

const POOL_SIZE = 32;

// Hardcoded hero image overrides — for categories where the Algolia data
// is too corrupted or inconsistent to pick a good shot automatically.
// Keys are display labels, values are either an absolute URL (e.g. a
// Shopify CDN image from an actual catalog product) or a relative path
// served from `public/`. The Algolia search still runs so the card's
// count badge stays accurate.
//
// Shoes → Khaite Miles Loafer in Black Alligator. Algolia's category
// index for shoes was mis-tagged badly enough that no amount of filter /
// whitelist tuning found a real shoe — using a specific product image
// from the catalog is the least fragile fix.
const CATEGORY_IMAGE_OVERRIDE: Record<string, string> = {
  // Khaite Miles Loafer in Black Alligator — shpfy-khaitecom-7899772420159
  "Shoes":                 "https://cdn.shopify.com/s/files/1/1519/7996/files/MILES-LOAFER-35_BLACK-ALLIGATOR_F4060-929-200_A.jpg?v=1768485966",
  // Cult Gaia Blythe Dress in Off White — shpfy-cultgaiacom-7894424911946
  "Dresses":               "https://cdn.shopify.com/s/files/1/0336/7793/files/260120_DR_CG_SP_HS26_RESHT_04_BLYTHE_DRESS_WHT_0010_WEBBED.jpg?v=1769043190",
  // Nour Hammour Birthday Coat in Black — html-nourhammourcom-birthdaycoatblackxs
  "Outerwear":             "https://cdn.shopify.com/s/files/1/0030/2946/7203/files/BirthdaycoatblackRegularPackshotShopify_2_81307e29-29b8-4f33-bed8-491a7fa5b218.jpg?v=1753199307",
  // Lisa Yang The Alvia Sweater in Black — shpfy-lisayangcom-14964704248183
  "Knits":                 "https://cdn.shopify.com/s/files/1/0550/4407/9778/files/LISAYANG_AW25_CAPSULE_ALVIA_SWEATER_2025372BL_BLACK_0038.jpg?v=1767079625",
  // The Row E/W Margaux Bag in Nubuck — page 2 of The Row products
  "Bags and accessories":  "https://cdn.shopify.com/s/files/1/0552/0313/5593/files/W1629L25NUBSF.jpg?v=1767974133",
};

export async function GET() {
  const appId = process.env.ALGOLIA_APP_ID ?? process.env.NEXT_PUBLIC_ALGOLIA_APP_ID ?? "BSDU5QFOT3";
  const key   = process.env.ALGOLIA_SEARCH_KEY
    ?? process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_KEY
    ?? process.env.ALGOLIA_ADMIN_KEY;

  if (!appId || !key) {
    return NextResponse.json({ error: "Missing Algolia credentials" }, { status: 500 });
  }

  const client = algoliasearch(appId, key);

  const results = await Promise.all(
    CATEGORIES.map(async ({ label, filters, query }) => {
      try {
        const res = await client.searchSingleIndex({
          indexName: INDEX_NAME,
          searchParams: {
            query,
            ...(filters ? { filters } : {}),
            ...(query ? { optionalWords: query.split(/\s+/).filter(Boolean) } : {}),
            hitsPerPage: POOL_SIZE,
            attributesToRetrieve: ["objectID", "image_url", "title"],
          },
        });
        const hits = (res.hits ?? []) as Array<{ image_url?: string; title?: string }>;

        // Hardcoded override takes precedence over everything else. Serves
        // from `public/…`. We still ran the Algolia query so we get an
        // accurate `count` for the card badge.
        const override = CATEGORY_IMAGE_OVERRIDE[label];
        if (override) {
          return { label, imageUrl: override, count: res.nbHits ?? null };
        }

        // Pass 1 — first hit with a valid image AND a title that matches
        // the category's whitelist / clears the blacklist.
        let imageUrl: string | null = null;
        for (const h of hits) {
          const img   = typeof h.image_url === "string" && h.image_url.startsWith("http") ? h.image_url : null;
          const title = typeof h.title === "string" ? h.title : "";
          if (img && titleOk(label, title)) {
            imageUrl = img;
            break;
          }
        }
        // Pass 2 — fallback to first hit with any image, ONLY for categories
        // without a whitelist. For Shoes / Dresses / etc., a miss on Pass 1
        // means our pool is corrupted and showing the first image would
        // just re-introduce the hoodie. Returning null makes the card
        // render with the cream placeholder background instead — far
        // better than a wrong hero.
        if (!imageUrl && !TITLE_WHITELIST[label]) {
          for (const h of hits) {
            if (typeof h.image_url === "string" && h.image_url.startsWith("http")) {
              imageUrl = h.image_url;
              break;
            }
          }
        }
        return { label, imageUrl, count: res.nbHits ?? null };
      } catch (e) {
        console.warn(`[category-index] ${label} failed:`, e instanceof Error ? e.message : e);
        return { label, imageUrl: null, count: null };
      }
    }),
  );

  return NextResponse.json({ categories: results });
}
