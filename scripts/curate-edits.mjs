/**
 * Seed content/edits.json with three hand-curated edits: streetwear, LBD, summer.
 *
 * Strategy per edit:
 *   1. Browse Algolia with a coarse category filter
 *   2. Apply a per-edit keyword match (title + color + material + description)
 *   3. Round-robin across categories, cap 2/brand, pick first N
 *
 * Rerun any time you want to refresh the seed. The JSON is meant to be hand-
 * edited afterwards — swap product_ids, replace hero_image_url with editorial
 * art, rewrite the subtitle, etc.
 *
 *   ALGOLIA_ADMIN_KEY=<key> node scripts/curate-edits.mjs
 */
import { algoliasearch } from "algoliasearch";
import fs from "fs";
import path from "path";

// Load .env.local
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
const SIZE_PER_EDIT     = 36;
const DEFAULT_MAX_PER_BRAND = 2;

if (!ALGOLIA_ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }

const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);

// ─── Edit definitions ─────────────────────────────────────────────────────────

const EDITS = [
  {
    slug:        "swimwear",
    title:       "Swimwear",
    subtitle:    "Bikinis, one-pieces, string, high-waisted",
    // Hand-picked editorial cover (Dippin Daisys Seaport Thong Bikini Bottom lifestyle shot).
    heroImageUrl: "https://cdn.shopify.com/s/files/1/1427/1236/files/SEAPORT-BOTTOM-BLACK-3.webp?v=1726270102",
    // Hand exclusions — products the filter admits but we don't want in the edit.
    excludeIds: [
      "shpfy-arthurapparelcom-9148247900375", // Arthur Apparel Mini Bikini Bottom in Black — user-rejected
    ],
    filter:      "", // broad — we filter in JS
    match: (p) => {
      const brand = (p.brand ?? "").toLowerCase();
      const t     = (p.title ?? "").toLowerCase();

      // Obvious rejects
      if (/\b(gown|tulle|bridal|wedding|gift\s*card|tarjeta\s*regalo|e-gift)\b/.test(t)) return false;
      // Accessories / footwear / non-swim items that share summer vocabulary
      if (/\b(sandal|shoe\b|heel|boot|clog|sunglass|earring|bracelet|necklace|ring\b|hair\s*clip|jaw\s*clip)\b/.test(t)) return false;
      // Cover-ups, sarongs, sundresses — bikinis only
      if (/\b(cover[\s-]?up|sarong|sundress|kaftan|caftan|pareo|wrap\s*dress)\b/.test(t)) return false;

      // Dippin Daisys is an all-swim brand — accept the whole catalog,
      // capped by maxPerBrand below.
      if (brand === "dippin daisys") return true;

      // Hard-swim keyword gate: title must explicitly say it's swim.
      return /\b(bikini|swimsuit|swim\s*(?:top|bottom|brief|short|set|wear|suit)|tankini|one[\s-]?piece\s*swim|bathing\s*suit|swimwear)\b/.test(t);
    },
    // Dippin Daisys anchors the edit; bump to 10 so they have a visible share
    // alongside the ~15 other swim brands in the catalog.
    maxPerBrand: { "Dippin Daisys": 10 },
    // Float Dippin Daisys to the top of each category bucket so the
    // round-robin fills with them first.
    prioritize: (p) => {
      const brand = (p.brand ?? "").toLowerCase();
      const t     = (p.title ?? "").toLowerCase();
      return brand === "dippin daisys"
          || /\b(bikini|swimsuit|swim\s*(?:top|bottom|brief|short)|tankini|one[\s-]?piece\s*swim)\b/.test(t);
    },
  },
  {
    slug:        "streetwear",
    title:       "Streetwear",
    subtitle:    "Zip hoodies, joggers, graphic tees",
    // Brand allowlist + per-brand cap below that lets 4028 dominate.
    // Restrict to top/bottom/jacket/shoes — drops stray dresses and mis-
    // categorized accessories (e.g. a Bubon beanie indexed as "bag").
    filter:      '(brand:"4028" OR brand:"Coramisa" OR brand:"Othernormal" OR brand:"Berlinc" OR brand:"Bubon") AND (category:top OR category:bottom OR category:jacket OR category:shoes)',
    match: () => true,
    // Overrides — how many per brand in final pick. 4028 is the anchor.
    maxPerBrand: { "4028": 10, "Coramisa": 8, "Othernormal": 8, "Berlinc": 6, "Bubon": 6 },
  },
  {
    slug:        "lbd",
    title:       "The Little Black Dress",
    subtitle:    "Black, mini, thirty ways",
    filter:      "category:dress",
    match: (p) => {
      const c = (p.color ?? "").toLowerCase().trim();
      const t = (p.title ?? "").toLowerCase();

      // Must explicitly be a MINI and have "dress" in the title — this
      // disqualifies accessories (clips, bralettes) mis-indexed as dresses.
      if (!/\bmini\b/.test(t))  return false;
      if (!/\bdress\b/.test(t)) return false;
      if (/\b(midi|maxi|long|floor|gown|full[-\s]?length)\b/.test(t)) return false;

      // Extra accessory / non-dress guards in case "mini" + "dress" both
      // appear in an accessory title by coincidence.
      if (/\b(clip|jaw|earring|necklace|bracelet|ring|shoe|bag|belt|hair\b)\b/.test(t)) return false;

      // Prints and patterns — check title and color field both
      const PATTERNS = /\b(floral|flower|print|stripe|check(?:ed|er)?|polka|gingham|leopard|tiger|rainbow|ombre|tie[\s-]?dye|camo|animal|paisley|combo|two[-\s]?tone|multi|mix|colou?rblock|ikat|jacquard|pineapple|abstract|graphic|embroidered)\b/;
      if (PATTERNS.test(t)) return false;
      if (c && PATTERNS.test(c)) return false;

      // Non-black colour words. If either color field OR title mentions
      // another colour, reject. This catches mis-tagged variants where
      // Algolia's color="Black" but title is "Lettuce Mini Dress - Lilac".
      const OTHER_COLORS = /\b(white|red|pink|blue|green|yellow|purple|brown|gold|silver|navy|cream|ecru|beige|tan|ivory|orange|grey|gray|rose|nude|olive|burgundy|taupe|charcoal|plum|lilac|lavender|mauve|khaki|rust|mint)\b/;
      if (OTHER_COLORS.test(t)) return false;

      // Case A: color field is populated. Must contain "black", no combos,
      // no other colour words, no pattern words.
      if (c) {
        if (!c.includes("black"))                                      return false;
        if (/[\/&]|\band\b|\swith\b|,/.test(c))                        return false;
        if (OTHER_COLORS.test(c))                                      return false;
        if (/\b(polka|print|floral|stripe|dot|pattern|check|plaid)\b/.test(c)) return false;
        return true;
      }

      // Case B: color field empty. Title must explicitly say "black".
      if (!/\bblack\b/.test(t)) return false;
      return true;
    },
  },

  // ─── Long-tail edits (not featured on homepage, shown on /edits index) ──────

  {
    slug:                "white-shirt",
    title:               "The White Shirt",
    subtitle:            "Oxford, poplin, bias-cut, oversized",
    filter:              "category:top",
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      const c = (p.color ?? "").toLowerCase().trim();
      // Must be a shirt/blouse — not a tee/tank/sweater
      if (!/\b(shirt|blouse|poplin|oxford|button[-\s]?(?:up|down))\b/.test(t)) return false;
      if (/\b(t[-\s]?shirt|\btee\b|tank|crewneck|sweat|hoodie|cardigan)\b/.test(t)) return false;
      // Must be white family
      const WHITE_RE = /(white|cream|ecru|ivory|off[-\s]?white|chalk)/;
      const OTHER_COLORS = /\b(red|pink|blue|green|yellow|purple|brown|gold|silver|navy|black|orange|grey|gray|plum|rust|olive|burgundy)\b/;
      if (OTHER_COLORS.test(t)) return false;
      if (c) {
        if (!WHITE_RE.test(c))                  return false;
        if (OTHER_COLORS.test(c))               return false;
        if (/[\/&]|\band\b|,/.test(c))          return false;
      } else {
        if (!WHITE_RE.test(t)) return false;
      }
      // No prints
      if (/\b(stripe|check|polka|floral|print|gingham|plaid)\b/.test(t)) return false;
      return true;
    },
  },

  {
    slug:                "trench",
    title:               "The Trench",
    subtitle:            "For the months that can't decide",
    filter:              "category:jacket",
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      if (!/\b(trench|mac\b|mackintosh|duster|rain[\s-]?coat)\b/.test(t)) return false;
      if (/\b(puffer|parka|sherpa|fleece|shearling|down)\b/.test(t)) return false;
      return true;
    },
  },

  {
    slug:                "slip-dress",
    title:               "The Slip Dress",
    subtitle:            "Silk, satin, bias-cut",
    filter:              "category:dress",
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      if (!/\bdress\b/.test(t)) return false;
      if (!/\b(slip|bias|cami(?:sole)?)\b/.test(t)) return false;
      // Not a top or coat mis-indexed as dress
      if (/\b(blazer|jacket|coat|sweater|cardigan|boxer|brief|thong|bralette)\b/.test(t)) return false;
      return true;
    },
  },

  {
    slug:                "cashmere",
    title:               "Cashmere",
    subtitle:            "Mill-spun, named-farm, built to last",
    filter:              "", // broad — cashmere shows up across tops/jackets/bottoms
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      const m = (p.material ?? "").toLowerCase();
      return /\bcashmere\b/.test(t) || /\bcashmere\b/.test(m);
    },
    // Johnstons of Elgin + Ghiaia Cashmere anchor; let them show more.
    maxPerBrand: { "Johnstons Of Elgin": 6, "Ghiaia Cashmere": 6 },
  },

  {
    slug:                "wide-leg-jeans",
    title:               "Wide-Leg Jeans",
    subtitle:            "Baggy, relaxed, straight-to-flare",
    filter:              "category:bottom",
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      if (!/\b(jean|denim)\b/.test(t))                                             return false;
      if (/\b(jacket|skirt|short\b|vest|dress)\b/.test(t))                         return false;
      if (!/\b(wide|baggy|relaxed|straight|flare|flared|boot[-\s]?cut|loose|oversized|trouser)\b/.test(t)) return false;
      if (/\b(skinny|slim|tapered|tight|cigarette)\b/.test(t))                     return false;
      return true;
    },
  },

  {
    slug:                "wedding-guest",
    title:               "Wedding Guest",
    subtitle:            "Midi to maxi, never white, never black",
    filter:              "category:dress",
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      const c = (p.color ?? "").toLowerCase().trim();
      if (!/\bdress\b/.test(t))                                                          return false;
      if (!/\b(midi|maxi|full[-\s]?length|floor[-\s]?length|column|wrap|a[-\s]?line|gown)\b/.test(t)) return false;
      if (/\b(bridal|wedding\s*dress|bride\b)\b/.test(t))                                return false;

      const h = `${t} ${c}`;

      // Hard reject any white/black/ivory family signal, EN + IT + FR.
      const EXCLUDE = /\b(white|ivory|cream|ecru|off[-\s]?white|chalk|black|nero|noir|blanc|bianco|jet|onyx|raven|charcoal)\b/;
      if (EXCLUDE.test(h)) return false;

      // Must carry a positive, non-white/black colour signal in title or
      // color field — otherwise we're gambling on ambiguous listings
      // ("V-Neck Midi Dress" with no color info could be anything).
      const POSITIVE = /\b(red|pink|rose|blush|fuchsia|magenta|coral|peach|salmon|orange|rust|copper|terracotta|amber|yellow|butter|mustard|gold|olive|green|sage|mint|emerald|forest|teal|turquoise|aqua|navy|blue|sky|cobalt|cerulean|periwinkle|indigo|purple|plum|lavender|lilac|mauve|grape|violet|aubergine|melanzana|brown|chocolate|cocoa|espresso|tan|camel|taupe|sand|beige|nude|khaki|burgundy|wine|maroon|oxblood|roseira|magnolia|marigold|ivy|chili|bloom|posie|floral|print|polka|stripe|paisley|multi)\b/;
      if (!POSITIVE.test(h)) return false;

      return true;
    },
  },

  {
    slug:                "resort",
    title:               "Resort",
    subtitle:            "Linen, crochet, raffia, sandals, canvas",
    filter:              "",
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      const m = (p.material ?? "").toLowerCase();
      const h = `${t} ${m}`;
      // Must hit a resort signal
      if (!/\b(linen|crochet|raffia|straw|espadrille|sandal|sundress|kaftan|caftan|cover[-\s]?up|sarong|pareo|beach|resort|tunic)\b/.test(h)) return false;
      // Explicitly exclude swim (lives in its own edit) and wintry
      if (/\b(bikini|swimsuit|tankini|one[-\s]?piece\s*swim|swim\s*(?:top|bottom|brief|short|set|wear|suit))\b/.test(t)) return false;
      if (/\b(wool|cashmere|fleece|parka|puffer|heavy\s*coat)\b/.test(h))          return false;
      // No gowns / bridal
      if (/\b(gown|bridal|wedding|tulle)\b/.test(t))                               return false;
      return true;
    },
  },

  {
    slug:                "office",
    title:               "The Office",
    subtitle:            "Tailored, confident, not corporate",
    filter:              "",
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      if (!/\b(blazer|trouser|loafer|oxford\s*shoe|pleated|button[-\s]?(?:up|down)|pencil\s*skirt|tailored|wool\s*pant|suit\s*pant)\b/.test(t)) return false;
      // No streetwear/loungewear
      if (/\b(hoodie|sweatpant|jogger|cargo|graphic\s*tee|tracksuit|sweatshirt)\b/.test(t)) return false;
      return true;
    },
  },

  {
    slug:                "quiet-luxury",
    title:               "Quiet Luxury",
    subtitle:            "No logos. No prints. Just fit, fabric, finish.",
    // Accept products from anchor brands OR anything in a luxurious natural
    // material. Then filter out loud prints/logos/graphics.
    filter:              "", // broad — we judge in JS via material + brand
    match: (p) => {
      const brand = (p.brand ?? "").toLowerCase();
      const t     = (p.title ?? "").toLowerCase();
      const m     = (p.material ?? "").toLowerCase();
      const h     = `${t} ${m}`;

      const ANCHOR_BRANDS = new Set([
        "st. agni", "tove", "johnstons of elgin", "ghiaia cashmere",
        "totême", "toteme", "lemaire", "le 17 septembre", "o. files",
        "khaite", "the row", "nour hammour", "casper the label",
      ]);
      const LUX_MATERIAL = /\b(cashmere|silk|wool|merino|camel\s*hair|suede|leather|linen|mohair|alpaca)\b/;

      if (!ANCHOR_BRANDS.has(brand) && !LUX_MATERIAL.test(h)) return false;

      // Drop loud prints, logos, graphics
      if (/\b(rainbow|neon|fluoro|patchwork|colou?rblock|tie[-\s]?dye|tropical|leopard|zebra|camo)\b/.test(t)) return false;
      if (/\b(logo|monogram|graphic\s*tee|graphic\s*t-shirt)\b/.test(t)) return false;
      // Drop obvious non-apparel household items (towels, blankets, napkins, washcloths)
      if (/\b(washcloth|dishcloth|napkin|placemat|pillow\s*case|duvet|doormat|blanket|throw)\b/.test(t)) return false;

      return true;
    },
    maxPerBrand: { "Johnstons Of Elgin": 5, "Ghiaia Cashmere": 5, "St. Agni": 5, "Tove": 5 },
  },

  {
    slug:                "old-money",
    title:               "Old Money",
    subtitle:            "Polo shirts, pleated skirts, loafers, pearls",
    filter:              "",
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      if (!/\b(polo|pleated\s*(?:skirt|trouser|pant)|pearl|cable[-\s]?knit|argyle|boat[-\s]?neck|button[-\s]?down|blazer|loafer|ballet\s*flat|camel\s*coat|cardigan|tennis|tartan|houndstooth|twin[-\s]?set)\b/.test(t)) return false;
      // No streetwear crossover
      if (/\b(hoodie|graphic\s*tee|cargo|baggy|track\s*pant|jogger)\b/.test(t)) return false;
      // Drop housewares (matched an "Argyle Rose Washcloth" — towels aren't old money).
      if (/\b(washcloth|dishcloth|napkin|placemat|towel|doormat|soap|candle)\b/.test(t)) return false;
      return true;
    },
  },

  {
    slug:                "coastal",
    title:               "Coastal",
    subtitle:            "Stripes, linen, raffia, rope — everywhere but the water",
    filter:              "",
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      const m = (p.material ?? "").toLowerCase();
      const h = `${t} ${m}`;
      if (!/\b(stripe|breton|mariniere|linen|rope|raffia|canvas|chambray|nautical|sailor|fisherman)\b/.test(h)) return false;
      // Swim has its own edit
      if (/\b(bikini|swimsuit|tankini|one[-\s]?piece\s*swim|swim\s*(?:top|bottom|brief|short|set|wear|suit))\b/.test(t)) return false;
      // Wintry items read differently
      if (/\b(parka|puffer|heavy\s*coat|fleece|shearling)\b/.test(h)) return false;
      return true;
    },
  },

  {
    slug:                "linen",
    title:               "All Linen",
    subtitle:            "The fabric that gets better the longer you own it",
    filter:              "",
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      const m = (p.material ?? "").toLowerCase();
      if (!/\blinen\b/.test(t) && !/\blinen\b/.test(m)) return false;
      // Exclude gowns/bridal — "linen wedding dress" isn't what we want here
      if (/\b(bridal|wedding\s*dress|tulle)\b/.test(t)) return false;
      return true;
    },
  },
];

// ─── Collect candidates ───────────────────────────────────────────────────────

async function collectCandidates(edit) {
  const excludeSet = new Set(edit.excludeIds ?? []);
  const candidates = [];
  await client.browseObjects({
    indexName: INDEX_NAME,
    browseParams: {
      ...(edit.filter ? { filters: edit.filter } : {}),
      hitsPerPage: 1000,
      attributesToRetrieve: [
        "objectID", "title", "brand", "price", "price_range",
        "color", "material", "description", "image_url", "images",
        "product_url", "retailer", "aesthetic_tags", "category",
      ],
    },
    aggregator: (res) => {
      for (const hit of res.hits) {
        if (excludeSet.has(hit.objectID)) continue;
        const img = hit.image_url ?? "";
        if (img.length < 20 || img.includes("blank.gif") || img.includes("placeholder")) continue;
        if (!edit.match(hit)) continue;
        candidates.push(hit);
      }
      process.stdout.write(`\r  [${edit.slug}] candidates: ${candidates.length.toLocaleString()}`);
    },
  });
  process.stdout.write("\n");
  return candidates;
}

// ─── Diversify & pick ─────────────────────────────────────────────────────────
// Round-robin across category buckets, cap MAX_PER_BRAND per brand.
// Shuffle within each bucket deterministically (by objectID hash) so reruns
// are stable unless the underlying data changes.

function pickDiverse(candidates, size, maxPerBrandOverrides = {}, prioritize = null) {
  const capFor = (brand) =>
    maxPerBrandOverrides[brand] ?? maxPerBrandOverrides[brand?.toLowerCase()] ?? DEFAULT_MAX_PER_BRAND;

  const byCat = new Map();
  for (const p of candidates) {
    const cat = p.category ?? "other";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(p);
  }
  // Sort: priority products first within each category, then stable by objectID.
  // Without the priority pass, a round-robin that only breaks ties by objectID
  // silently skips later-alphabet brands — e.g. Dippin Daisys never surfaced
  // because Aje/Anine-Bing/Aventura filled every category's opening slots.
  for (const arr of byCat.values()) {
    arr.sort((a, b) => {
      if (prioritize) {
        const pa = prioritize(a) ? 0 : 1;
        const pb = prioritize(b) ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
      return a.objectID.localeCompare(b.objectID);
    });
  }

  const cats = [...byCat.keys()];
  const idx  = Object.fromEntries(cats.map((c) => [c, 0]));
  const perBrand   = new Map();
  const seenTitles = new Set(); // dedup identical (brand|title) products — catalog has real dupes
  const picked     = [];

  outer: while (picked.length < size) {
    let progress = false;
    for (const cat of cats) {
      if (picked.length >= size) break outer;
      const arr = byCat.get(cat);
      while (idx[cat] < arr.length) {
        const p = arr[idx[cat]++];
        const brand = p.brand ?? "";
        if ((perBrand.get(brand) ?? 0) >= capFor(brand)) continue;
        const titleKey = `${brand.toLowerCase()}|${(p.title ?? "").toLowerCase().trim()}`;
        if (seenTitles.has(titleKey)) continue;
        seenTitles.add(titleKey);
        perBrand.set(brand, (perBrand.get(brand) ?? 0) + 1);
        picked.push(p);
        progress = true;
        break;
      }
    }
    if (!progress) break;
  }

  return picked;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const out = [];
  for (const edit of EDITS) {
    console.log(`\n→ Curating "${edit.title}"`);
    const candidates = await collectCandidates(edit);
    const picked     = pickDiverse(candidates, SIZE_PER_EDIT, edit.maxPerBrand ?? {}, edit.prioritize ?? null);
    const brands     = new Set(picked.map((p) => p.brand));
    const cats       = new Set(picked.map((p) => p.category ?? "other"));
    console.log(`  Picked: ${picked.length} across ${brands.size} brands, ${cats.size} categories`);

    out.push({
      slug:                 edit.slug,
      title:                edit.title,
      subtitle:             edit.subtitle,
      // Hero: per-edit override wins; otherwise fall back to the first
      // picked product's image as a placeholder.
      hero_image_url:       edit.heroImageUrl ?? picked[0]?.image_url ?? null,
      product_ids:          picked.map((p) => p.objectID),
      // Default to homepage-featured for backwards compat; new long-tail edits
      // set featuredOnHomepage: false so only the top 3 lead the homepage.
      featured_on_homepage: edit.featuredOnHomepage ?? true,
      published_at:         new Date().toISOString().slice(0, 10),
    });
  }

  const outPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "content", "edits.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n✓ Wrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
