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
    slug:        "streetwear",
    title:       "Streetwear",
    subtitle:    "Zip hoodies, joggers, graphic tees",
    description: "4028 and its peers — racing hoodies, selvedge baggy jeans, MA-1 bombers, tracksuits. Graphic-forward small labels making the real thing, not the fashion-week version.",
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
    description: "The one dress that earns its spot in every wardrobe — black, above-the-knee, no prints, no distractions. A tight survey of the short black dress, brand by brand.",
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
  {
    slug:        "summer",
    title:       "Summer",
    subtitle:    "Bikinis, linen, long evenings",
    description: "The pieces for the slow months. Dippin Daisys across the pool deck, loose linen, cotton sundresses, sandals worn through. A summer wardrobe, not a summer trend.",
    filter:      "", // broad — we filter in JS
    match: (p) => {
      const brand = (p.brand ?? "").toLowerCase();
      const t = (p.title ?? "").toLowerCase();
      const m = (p.material ?? "").toLowerCase();
      const c = (p.color ?? "").toLowerCase();
      const h = `${t} ${m}`;

      // Reject formal / bridal / vintage-gown territory (catches the 1930s
      // Hand Crochet Tulle Gown that was slipping through on "crochet").
      if (/\b(gown|tulle|bridal|wedding|corset|victorian|edwardian|regency|1920s?|1930s?|1940s?|1950s?|debutante|ball\s*gown|floor[\s-]?length|opera|evening\s*gown)\b/.test(t)) return false;
      if (/\b(wool|cashmere|fleece|fur|leather\s*jacket|parka|puffer|heavy\s*coat|winter\s*coat)\b/.test(h)) return false;
      // Reject gift cards (EN + ES) — "Tarjeta Regalo" was slipping in on "Bikini Lab" in the title.
      if (/\b(gift\s*card|tarjeta\s*regalo|tarjeta\s*de\s*regalo|e-gift)\b/.test(t)) return false;

      // Dippin Daisys — pass-through the whole brand (it's a swim label,
      // everything they make is summer). Per-brand cap controls volume.
      if (brand === "dippin daisys") return true;

      // Strong summer signals — swim gets priority weight (bikini/swimsuit
      // always passes; other signals still require non-wintry context above).
      if (/\b(bikini|swimsuit|one[\s-]?piece\s*swim|swim\s*(?:top|bottom|brief|short)|beachwear|swimwear|tankini)\b/.test(t)) return true;

      if (/\b(linen|sundress|eyelet|broderie|seersucker|poplin|espadrille|sandal|straw|raffia|crochet|chambray)\b/.test(h)) return true;

      // Light colours + summery silhouettes
      if (/\b(short|sundress|camisole|tank|tube\s*top|shift\s*dress)\b/.test(t) &&
          /\b(white|cream|ecru|yellow|pink|blue|sky|mint|butter|coral|peach)\b/.test(c)) return true;

      return false;
    },
    // Cap Dippin Daisys at 8 so they anchor but don't dominate the 36-item grid.
    maxPerBrand: { "Dippin Daisys": 8 },
    // Float Dippin Daisys + any bikini/swim product to the top of their
    // category bucket so the round-robin picks swim first.
    prioritize: (p) => {
      const brand = (p.brand ?? "").toLowerCase();
      const t     = (p.title ?? "").toLowerCase();
      return brand === "dippin daisys"
          || /\b(bikini|swimsuit|swim\s*(?:top|bottom|brief|short)|tankini|one[\s-]?piece\s*swim)\b/.test(t);
    },
  },
];

// ─── Collect candidates ───────────────────────────────────────────────────────

async function collectCandidates(edit) {
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
      description:          edit.description,
      // Default hero = first product's image. Replace with editorial art when available.
      hero_image_url:       picked[0]?.image_url ?? null,
      product_ids:          picked.map((p) => p.objectID),
      featured_on_homepage: true,
      published_at:         new Date().toISOString().slice(0, 10),
    });
  }

  const outPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "content", "edits.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n✓ Wrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
