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
// Per-brand default cap. With it at 2, edits felt tokenized; with no cap at
// all, alphabetically-early brands filled entire 36-slot edits and pushed
// everything else out. 8 strikes a balance — a brand can anchor an edit
// without dominating it, and individual edits can still override.
const DEFAULT_MAX_PER_BRAND = 8;

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
      // Kids / maternity
      if (/\b(baby|infant|toddler|kids|children|girl\s|boy\s|maternity)\b/.test(t)) return false;

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
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      if (/\b(baby|infant|toddler|kids|children|maternity)\b/.test(t)) return false;
      return true;
    },
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
      if (/\b(baby|infant|toddler|kids|children|maternity|nightgown|sleep|lingerie|pajama|pyjama)\b/.test(t)) return false;

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
      // Must be a shirt/blouse — not a tee/tank/sweater/sleepwear
      if (!/\b(shirt|blouse|poplin|oxford|button[-\s]?(?:up|down))\b/.test(t)) return false;
      if (/\b(t[-\s]?shirt|\btee\b|tank|crewneck|sweat|hoodie|cardigan|pajama|pyjama|nightshirt|night\s*shirt|sleep|robe|bathrobe)\b/.test(t)) return false;
      if (/\b(baby|infant|toddler|kids|maternity)\b/.test(t)) return false;
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
      if (/\b(puffer|parka|sherpa|fleece|shearling|down|quilted|puffy)\b/.test(t)) return false;
      if (/\b(baby|infant|toddler|kids|maternity|pet|dog\b|cat\b)\b/.test(t)) return false;
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
      // Not a top / coat / sleepwear / lingerie mis-indexed as dress
      if (/\b(blazer|jacket|coat|sweater|cardigan|boxer|brief|thong|bralette)\b/.test(t)) return false;
      if (/\b(nightgown|night\s*dress|sleep|lingerie|robe|bathrobe|pajama|pyjama|chemise)\b/.test(t)) return false;
      if (/\b(baby|infant|toddler|kids|maternity)\b/.test(t)) return false;
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
      if (!/\bcashmere\b/.test(t) && !/\bcashmere\b/.test(m)) return false;
      // Drop housewares (blankets, throws, pillows, duvets, bedding)
      if (/\b(blanket|throw|pillow|cushion|bedding|duvet|sheet|tablecloth|napkin|placemat|doormat|washcloth)\b/.test(t)) return false;
      if (/\b(baby|infant|toddler|kids|maternity|pet|dog\b|cat\b)\b/.test(t)) return false;
      return true;
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
      if (/\b(baby|infant|toddler|kids|maternity)\b/.test(t))                      return false;
      return true;
    },
  },

  {
    slug:                "wedding-guest",
    title:               "Wedding Guest",
    subtitle:            "Silk, satin, chiffon, gowns — midi to maxi",
    filter:              "category:dress",
    match: (p) => {
      const t = (p.title ?? "").toLowerCase();
      const c = (p.color ?? "").toLowerCase().trim();
      const m = (p.material ?? "").toLowerCase();
      const d = (p.description ?? "").toLowerCase();
      const h = `${t} ${c} ${m} ${d}`;

      if (!/\b(dress|gown)\b/.test(t))                                                              return false;
      if (!/\b(midi|maxi|full[-\s]?length|floor[-\s]?length|column|wrap|a[-\s]?line|gown)\b/.test(t)) return false;
      if (/\b(bridal|wedding\s*dress|bride\b)\b/.test(t))                                           return false;
      if (/\b(baby|infant|toddler|kids|children|maternity|nightgown|sleep|lingerie|pajama|pyjama)\b/.test(t)) return false;

      // Hard reject white/black/ivory family (bride's colors), EN + IT + FR.
      const WHITE_BLACK = /\b(white|ivory|cream|ecru|off[-\s]?white|chalk|black|nero|noir|blanc|bianco|jet|onyx|raven|charcoal)\b/;
      if (WHITE_BLACK.test(`${t} ${c}`)) return false;

      // Reject "dowdy" / too-casual signals — the stuff that reads like a day
      // dress, not an evening one. Smocked + prairie + tiered cottagecore,
      // beach-shape kaftans, denim/gingham/plaid. These make the edit feel
      // matronly or like Sunday brunch, not a cocktail hour.
      const DOWDY = /\b(smock(?:ed)?|prairie|peasant|shirtdress|t[-\s]?shirt\s*dress|polo\s*dress|polo\s*(?:mini|midi|maxi)|knit\s*polo|milkmaid|sundress|sun[-\s]?dress|beach\s*dress|cover[-\s]?up|caftan|kaftan|muumuu|gauze|linen|poplin|cotton\s*(?:gauze|poplin|jersey)|denim|gingham|chambray|plaid|flannel|corduroy|oversized|relax(?:ed)?[-\s]?fit|boho|bohemian|prairie|mini\s*dress)\b/;
      if (DOWDY.test(h)) return false;

      // Reject earthy / neutral colors — technically "color signals" but they
      // skew dowdy and read as everyday-wear. Save these for the Resort edit.
      const DULL_COLOR = /\b(sand|beige|oatmeal|stone|mushroom|mocha|taupe|camel|khaki|sage|olive|army|forest|moss|chocolate|espresso|coffee|bronze|natural|nude|ecru|tan\b)\b/;
      if (DULL_COLOR.test(`${t} ${c}`)) return false;

      // Reject stripes and polka dot — retro/day-dress territory, rarely
      // reads wedding-formal unless stone-cold couture.
      if (/\b(stripe|striped|pinstripe|polka)\b/.test(h)) return false;

      // Reject collar/collared language — strong tell for a shirt-ish day dress.
      if (/\b(collar|collared|peter\s*pan|button[-\s]?down)\b/.test(t)) return false;

      // Require at least one formal-occasion signal. This is the crux of the
      // fix: the old filter only checked "is it midi/maxi with a color" which
      // let day-dresses slip in. Now we require the garment to actually read
      // like occasionwear — via fabric, silhouette, or explicit language.
      const FORMAL_FABRIC     = /\b(silk|satin|velvet|chiffon|tulle|sequin(?:ed|s)?|bead(?:ed|s|ing)?|lam[ée]|metallic|lurex|organza|taffeta|brocade|jacquard|lace|crepe|duchess|mikado)\b/;
      const FORMAL_SILHOUETTE = /\b(gown|column|sheath|mermaid|halter|cowl|backless|one[-\s]?shoulder|strapless|bias|slip|drap(?:e|ed|ing)|cors(?:et|eted)|bodice|fit[-\s]?and[-\s]?flare|plunge|plunging)\b/;
      const FORMAL_OCCASION   = /\b(formal|evening|occasion|cocktail|black[-\s]?tie|gala|ballroom|red[-\s]?carpet|party)\b/;
      if (!(FORMAL_FABRIC.test(h) || FORMAL_SILHOUETTE.test(h) || FORMAL_OCCASION.test(h))) return false;

      // Positive colour signal in title or color field.
      const POSITIVE = /\b(red|pink|rose|blush|fuchsia|magenta|coral|peach|salmon|orange|rust|copper|terracotta|amber|yellow|butter|mustard|gold|mint|emerald|teal|turquoise|aqua|navy|blue|sky|cobalt|cerulean|periwinkle|indigo|purple|plum|lavender|lilac|mauve|grape|violet|aubergine|melanzana|burgundy|wine|maroon|oxblood|roseira|magnolia|marigold|chili|bloom|posie|floral|print|polka|paisley|multi|champagne|silver|rose[-\s]?gold)\b/;
      if (!POSITIVE.test(h)) return false;

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
      // No streetwear / loungewear / athleisure / resort
      if (/\b(hoodie|sweatpant|jogger|cargo|graphic\s*tee|tracksuit|sweatshirt|athleisure|yoga|gym|pajama|pyjama|sleep|robe|kaftan|sarong|bikini|swim)\b/.test(t)) return false;
      if (/\b(baby|infant|toddler|kids|maternity|pet)\b/.test(t)) return false;
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
      // Not loungewear / streetwear / cold-weather — coastal should feel breezy
      if (/\b(hoodie|sweatshirt|sweater|cardigan|crewneck|jean|denim|blazer|trench|parka|puffer|fleece|shearling|tweed|corduroy|velvet)\b/.test(h)) return false;
      if (/\b(wool|cashmere|merino|mohair|alpaca|flannel)\b/.test(h)) return false;
      if (/\b(baby|infant|toddler|kids|maternity|pet)\b/.test(t)) return false;
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
      // Drop housewares (linen napkins, tablecloths, sheets, duvets, towels)
      if (/\b(napkin|placemat|tablecloth|sheet\b|bedding|duvet|pillowcase|pillow\s*case|tea\s*towel|dish\s*towel|curtain|washcloth|doormat|blanket|throw)\b/.test(t)) return false;
      // Drop sleepwear
      if (/\b(pajama|pyjama|nightgown|night\s*dress|night\s*shirt|robe|bathrobe)\b/.test(t)) return false;
      if (/\b(baby|infant|toddler|kids|maternity|pet)\b/.test(t)) return false;
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
