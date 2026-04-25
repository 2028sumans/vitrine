/**
 * Audit Algolia category labels for obvious mis-tags.
 *
 * Why: /api/debug/clip surfaced an eyeshadow palette tagged `top`, a
 * swimsuit tagged `dress`, and a shoe tagged `top` among the top-5
 * FashionCLIP neighbours for "y2k party". Mis-tagged items poison
 * every category-filtered search regardless of how good the embedding
 * step is — even strict CLIP can't undo `category=top` when the front-
 * end requested tops.
 *
 * Approach: pull every product, run the title through a list of
 * category-vs-keyword rules. Each rule says "if title contains X but
 * category is Y, flag it." Zero machine learning — just the loud,
 * obvious failures.
 *
 * Output: JSON report at scripts/category-mistag-report.json grouped
 * by failure rule. The report is read-only — pass --apply to actually
 * mutate Algolia. Default is dry-run.
 */
import "dotenv/config";
import { writeFileSync } from "fs";
import { algoliasearch } from "algoliasearch";
import { Pinecone }      from "@pinecone-database/pinecone";

const APP_ID    = process.env.ALGOLIA_APP_ID;
const ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const INDEX     = process.env.ALGOLIA_INDEX ?? "vitrine_products";
const APPLY     = process.argv.includes("--apply");

// Optional --rules=name1,name2 — restrict the apply step to a subset of
// rules. The dry-run report still scans every rule (so you can compare
// confidence before applying). Default: every rule applies.
const rulesArg = process.argv.find((a) => a.startsWith("--rules="));
const RULES_FILTER = rulesArg
  ? new Set(rulesArg.slice("--rules=".length).split(",").map((s) => s.trim()).filter(Boolean))
  : null;

if (!APP_ID || !ADMIN_KEY) {
  console.error("Missing ALGOLIA_APP_ID or ALGOLIA_ADMIN_KEY");
  process.exit(1);
}

const client = algoliasearch(APP_ID, ADMIN_KEY);

// ── Mis-tag rules ───────────────────────────────────────────────────────────
// Each rule: if the (lowercased) title matches `pattern` AND category ∈ `wrongCats`,
// then this product is mis-categorized. `correctAction` says what we'd do if
// --apply were set: "delete" for non-fashion (beauty, fragrance, lifestyle),
// "recategorize" with a target category for genuine fashion items in the
// wrong bucket. Keep patterns conservative — false positives here demote
// real products from the index.

// Each rule may also specify `excludeIfMatches`: a regex that, if it
// matches the title, suppresses the rule. Use this to dodge the tight
// false-positive cases (e.g. "blush" as a color word, "sweater dress"
// being a real dress, top-and-skirt sets, Olympia Le-Tan's bag line
// called "Ballerina").

const RULES = [
  // Beauty — only flag tokens that are unambiguously cosmetic. Dropped
  // generic "palette" (could be a color palette description), "blush"
  // (color word in titles like "1920s Blush Egyptian Gown"), "primer"
  // (clothing primer fabric), bare "lipstick" (used as a color, e.g.
  // "Boden Sandal in Lipstick Suede"), and bare "perfume" (used as a
  // motif, e.g. "Perfume Bottle Embroidery Denim Bag"). Require a
  // cosmetic-context qualifier to keep the rule honest.
  {
    name:          "beauty_in_apparel",
    pattern:       /\b(eyeshadow|eye shadow|mascara|concealer|highlighter palette|bronzer palette|setting spray|setting powder|nail polish|nail lacquer|eau de parfum|eau de toilette|sheet mask)\b/i,
    wrongCats:     ["top", "dress", "bottom", "jacket", "shoes", "bag"],
    correctAction: "delete",
  },

  // Lifestyle — dropped "scrunchie" (often a fabric finish, e.g. "scrunchie
  // taffeta"), "incense" (could be incense-color description), and "hair
  // clip"/"hair tie" (real fashion accessories). Kept the loud ones.
  {
    name:          "lifestyle_in_apparel",
    pattern:       /\b(candle|diffuser|throw pillow|coaster|tumbler|water bottle|bath salts|body scrub|body wash|hand cream|lip balm|sheet mask|incense holder|incense burner|incense stick)\b/i,
    wrongCats:     ["top", "dress", "bottom", "jacket"],
    correctAction: "delete",
  },

  // Swimwear in dresses — tightened: require explicit swim words. "One
  // piece" alone matches too many jumpsuits/bodysuits, so require the
  // qualifier (one-piece swimsuit, one-piece bathing suit) OR a swim-
  // specific brand context. We also exclude items whose title contains
  // "dress" — a "Brigitte One Piece Dress" stays a dress.
  {
    name:          "swimwear_in_dress",
    pattern:       /\b(bikini|swimsuit|swim suit|bathing suit|one[- ]piece swim|tankini|monokini|rashguard|rash guard)\b/i,
    excludeIfMatches: /\b(dress|gown)\b/i,
    wrongCats:     ["dress"],
    correctAction: "recategorize",
    target:        "other",
  },
  {
    name:          "swimwear_in_top_or_bottom",
    // Bikini tops and bottoms legitimately live in top/bottom buckets,
    // so skip those — only flag the all-in-ones.
    pattern:       /\b(one[- ]piece swimsuit|one[- ]piece bathing suit|monokini|tankini\b(?! top| bottom))/i,
    wrongCats:     ["top", "bottom"],
    correctAction: "recategorize",
    target:        "other",
  },

  // Shoes mis-tagged elsewhere. Excluded "ballerina" / "ballet flat" since
  // Olympia Le-Tan has a famous "Ballerina" bag line. Also excluded
  // "boot" alone (bootcut jeans, bootleg). Kept the unambiguous footwear.
  // Additionally, exclude when title also contains apparel words —
  // e.g. "MARY JANE MINI SKIRT" is a skirt with a Mary-Jane motif name,
  // and "DENIM STILETTO BOOTS" is a real boot but tagged bottom; we don't
  // want to flag fashion items where the shoe word is metaphorical.
  {
    name:          "shoes_mistagged",
    pattern:       /\b(sneaker|trainer|loafer(?:s)?|mule(?:s)?|sandal(?:s)?|stiletto(?:s)?|pump heel(?:s)?|kitten heel(?:s)?|wedge heel(?:s)?|ankle boot(?:s)?|knee[- ]high boot(?:s)?|chelsea boot(?:s)?|combat boot(?:s)?|cowboy boot(?:s)?|riding boot(?:s)?|moccasin(?:s)?|oxford shoe(?:s)?|derby shoe(?:s)?|brogue(?:s)?|espadrille(?:s)?|slingback(?:s)?|platform sandal(?:s)?|flat sandal(?:s)?)\b/i,
    excludeIfMatches: /\b(bag|handbag|tote|clutch|backpack|hat|earring|necklace|ring|skirt|mini skirt|midi skirt|dress|top|shirt|blouse|tee|tank|hoodie|sweater|cardigan|sweatshirt|trouser|jeans|pants|shorts)\b/i,
    wrongCats:     ["top", "dress", "bottom", "jacket"],
    correctAction: "recategorize",
    target:        "shoes",
  },

  // Bags mis-tagged elsewhere. Strong patterns — "handbag", "tote", "clutch"
  // etc. are unambiguous in apparel context.
  {
    name:          "bags_mistagged",
    pattern:       /\b(handbag|tote bag|crossbody bag|crossbody|clutch bag|satchel|backpack|messenger bag|duffle bag|fanny pack|bumbag|hobo bag|saddle bag|bucket bag|shoulder bag|baguette bag|top handle bag|mini bag|shopper bag)\b/i,
    excludeIfMatches: /\b(top|dress|skirt|pants|jacket|shoes)\b/i,
    wrongCats:     ["top", "dress", "bottom", "jacket"],
    correctAction: "recategorize",
    target:        "bag",
  },

  // Dresses mis-tagged as top (full-length pieces). Tightened — dropped
  // bare "gown" since it was matching pieces like "ball gown skirt".
  {
    name:          "dress_in_top",
    pattern:       /\b(maxi dress|midi dress|mini dress|sundress|sun dress|wrap dress|slip dress|shirtdress|shirt dress|t[- ]shirt dress|sweater dress|knit dress|kaftan dress|caftan dress|cocktail dress|bodycon dress|prom dress|evening gown|ball gown)\b/i,
    wrongCats:     ["top"],
    correctAction: "recategorize",
    target:        "dress",
  },

  // Tops mis-tagged as dress. Exclude when title also contains "dress" —
  // "Polo Shirt Dress", "Corset Top Bodycon Dress" etc. are real
  // dresses where the top word is part of the styling description.
  {
    name:          "top_in_dress",
    pattern:       /\b(crop top|tank top|cami top|camisole top|polo shirt|bralette top|bustier top|corset top)\b/i,
    excludeIfMatches: /\bdress\b/i,
    wrongCats:     ["dress"],
    correctAction: "recategorize",
    target:        "top",
  },

  // Bottoms mis-tagged as top. Heavily tightened: only flag when the
  // title is clearly a bottoms-only item. Sets ("top and skirt", "top &
  // pants", "shirt + trouser") are LEGITIMATELY tagged top because the
  // top is the lead piece. Require the title to NOT contain top words.
  {
    name:          "bottom_in_top",
    pattern:       /\b(jeans|trousers|skirt|shorts|leggings|culottes|chinos|joggers|sweatpants|cargo pants|wide[- ]leg pants|wide leg trouser|pleated trouser|straight leg pant|baggy pant)\b/i,
    excludeIfMatches: /\b(top|shirt|blouse|tee|tank|hoodie|sweater|cardigan|sweatshirt|jumper|polo|crop|corset|bustier|bralette|bodysuit|bodice|set|suit|matching|two[- ]piece|2[- ]piece|& |and skirt|and pants|and trouser|and jeans)\b/i,
    wrongCats:     ["top"],
    correctAction: "recategorize",
    target:        "bottom",
  },
];

// ── Pull every product (paginated) ──────────────────────────────────────────

async function pullEveryProduct() {
  let allHits = [];
  let cursor;
  let pages   = 0;

  while (true) {
    const res = await client.browse({
      indexName:  INDEX,
      browseParams: {
        attributesToRetrieve: ["objectID", "title", "name", "category", "brand"],
        hitsPerPage:          1000,
        ...(cursor ? { cursor } : {}),
      },
    });
    allHits = allHits.concat(res.hits ?? []);
    pages++;
    process.stdout.write(`\r  fetched ${allHits.length} products (page ${pages})…`);
    if (!res.cursor) break;
    cursor = res.cursor;
  }
  process.stdout.write("\n");
  return allHits;
}

// ── Main ────────────────────────────────────────────────────────────────────

console.log(`── Audit: category mis-tags in ${INDEX} ─────────────`);
console.log(`  Mode: ${APPLY ? "APPLY (will mutate Algolia)" : "DRY-RUN (report only)"}`);

const products = await pullEveryProduct();
console.log(`  Total products: ${products.length}`);

const flagged = {};
for (const rule of RULES) flagged[rule.name] = [];

for (const p of products) {
  const titleRaw = (p.title ?? p.name ?? "").trim();
  if (!titleRaw) continue;
  const title = titleRaw.toLowerCase();
  const cat   = (p.category ?? "").toLowerCase();

  for (const rule of RULES) {
    if (!rule.wrongCats.includes(cat)) continue;
    if (!rule.pattern.test(title)) continue;
    if (rule.excludeIfMatches && rule.excludeIfMatches.test(title)) continue;
    flagged[rule.name].push({
      objectID: p.objectID,
      title:    titleRaw,
      brand:    p.brand,
      category: p.category,
      ...(rule.correctAction === "recategorize" ? { suggested: rule.target } : { suggested: "DELETE" }),
    });
    break; // one rule per product is enough
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`\n── Flagged products by rule ─────────────────────────`);
let totalFlagged = 0;
for (const rule of RULES) {
  const hits = flagged[rule.name];
  totalFlagged += hits.length;
  console.log(`  ${rule.name.padEnd(34)} ${String(hits.length).padStart(5)} hits`);
  for (const h of hits.slice(0, 3)) {
    console.log(`    [${h.category}→${h.suggested}]  ${h.brand ?? "?"}  ·  ${h.title.slice(0, 70)}`);
  }
  if (hits.length > 3) console.log(`    … +${hits.length - 3} more`);
}
console.log(`\n  TOTAL FLAGGED: ${totalFlagged}`);

const reportPath = "scripts/category-mistag-report.json";
writeFileSync(reportPath, JSON.stringify({
  index:    INDEX,
  total:    products.length,
  flagged_total: totalFlagged,
  flagged,
  rules:    RULES.map(({ name, correctAction, target }) => ({ name, correctAction, target })),
  generated_at: new Date().toISOString(),
}, null, 2));
console.log(`\n  Full report: ${reportPath}`);

if (!APPLY) {
  console.log(`\n  Dry-run only. Re-run with --apply to mutate Algolia.`);
  process.exit(0);
}

// ── Apply (only with --apply) ───────────────────────────────────────────────

console.log(`\n── Applying changes to ${INDEX} ─────────────────────`);

const toDelete       = [];
const toRecategorize = []; // { objectID, target }

for (const rule of RULES) {
  if (RULES_FILTER && !RULES_FILTER.has(rule.name)) {
    console.log(`  ⏭  skipping rule '${rule.name}' (not in --rules filter)`);
    continue;
  }
  for (const hit of flagged[rule.name]) {
    if (rule.correctAction === "delete") {
      toDelete.push(hit.objectID);
    } else {
      toRecategorize.push({ objectID: hit.objectID, target: rule.target });
    }
  }
}

if (toDelete.length > 0) {
  console.log(`  Deleting ${toDelete.length} non-fashion items from Algolia…`);
  // Algolia batch delete — chunk to 1000s
  for (let i = 0; i < toDelete.length; i += 1000) {
    const chunk = toDelete.slice(i, i + 1000);
    await client.deleteObjects({ indexName: INDEX, objectIDs: chunk });
  }

  // Mirror the deletion in Pinecone so the vector index stays in sync
  // with Algolia. Otherwise FashionCLIP search would return ids for
  // products that no longer exist in Algolia, and the post-fetch
  // metadata join would silently drop them — wasting a Pinecone topK
  // slot per deleted item.
  //
  // API note: Pinecone's deleteMany takes an OBJECT { ids: [...] }, not
  // the raw array. Passing an array makes the SDK send the request with
  // ids serialised wrong and Pinecone replies "Invalid request". The
  // default namespace is also literally named "__default__" — calling
  // pc.index().deleteMany() goes to a nameless namespace that doesn't
  // hold the production vectors. See scripts/delete-camilla-babies-
  // pinecone.mjs for the canonical pattern.
  if (process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX) {
    console.log(`  Deleting ${toDelete.length} vectors from Pinecone (visual + vibe)…`);
    const pc          = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    const idx         = pc.index(process.env.PINECONE_INDEX);
    const visualNs    = idx.namespace("__default__");
    const vibeNs      = idx.namespace("vibe");
    let visualDeleted = 0, vibeDeleted = 0, errors = 0;
    for (let i = 0; i < toDelete.length; i += 1000) {
      const chunk = toDelete.slice(i, i + 1000);
      try {
        await visualNs.deleteMany({ ids: chunk });
        visualDeleted += chunk.length;
      } catch (err) {
        errors++;
        console.warn(`    visual chunk@${i}: ${err.message ?? err}`);
      }
      try {
        await vibeNs.deleteMany({ ids: chunk });
        vibeDeleted += chunk.length;
      } catch (err) {
        errors++;
        console.warn(`    vibe chunk@${i}: ${err.message ?? err}`);
      }
    }
    console.log(`    visual ns: ${visualDeleted}, vibe ns: ${vibeDeleted}, errors: ${errors}`);
  } else {
    console.log("  ⚠  PINECONE_API_KEY/PINECONE_INDEX not set — skipping Pinecone cleanup");
  }
}

if (toRecategorize.length > 0) {
  console.log(`  Recategorizing ${toRecategorize.length} items…`);
  // Partial-update each — Algolia supports partialUpdateObjects in batches
  for (let i = 0; i < toRecategorize.length; i += 1000) {
    const chunk = toRecategorize.slice(i, i + 1000);
    await client.partialUpdateObjects({
      indexName: INDEX,
      objects:   chunk.map(({ objectID, target }) => ({ objectID, category: target })),
    });
  }
}

console.log(`\n  Done. Deleted ${toDelete.length}, recategorized ${toRecategorize.length}.`);
