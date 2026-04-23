/**
 * Vision-aware edit curator.
 *
 * curate-edits.mjs builds edits with text-only regex matching on Algolia
 * fields. That misses the actual aesthetic — a "Polo Knitted Dress Nero" can
 * match `\bpolo\b` even though the image shows a sheer black mesh maxi that
 * has nothing to do with old money. A "Pleated Tennis Skort" with a giant
 * branded waistband matches `pleated` + `tennis` but visually screams athleisure.
 *
 * This curator uses the existing FashionCLIP text encoder (the same model that
 * embedded every image in Pinecone) to encode an aesthetic prompt → query
 * Pinecone for visually-nearest products → cross-reference Algolia for
 * filtering / brand-capping / final selection.
 *
 * Run:
 *   PINECONE_API_KEY=... ALGOLIA_ADMIN_KEY=... \
 *     node scripts/curate-vision.mjs --slug=old-money --apply
 *
 * Flags:
 *   --slug=<edit-slug>   which edit to regenerate (required)
 *   --top=<N>            target product count (default 36)
 *   --candidates=<N>     candidate pool size from Pinecone (default 400)
 *   --max-per-brand=<N>  cap each brand's contribution (default 4)
 *   --apply              actually write to content/edits.json (otherwise dry-run)
 *   --keep=<id1,id2,…>   product_ids to retain regardless of new picks
 */

import { Pinecone } from "@pinecone-database/pinecone";
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
const PINECONE_API_KEY  = process.env.PINECONE_API_KEY;
const PINECONE_INDEX    = process.env.PINECONE_INDEX ?? "muse";
const ALGOLIA_INDEX     = "vitrine_products";
// Must match scripts/embed-with-qc.mjs and lib/embeddings.ts.
const MODEL_ID          = "ff13/fashion-clip";

if (!ALGOLIA_ADMIN_KEY) { console.error("Missing ALGOLIA_ADMIN_KEY"); process.exit(1); }
if (!PINECONE_API_KEY)  { console.error("Missing PINECONE_API_KEY");  process.exit(1); }

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name, def) {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return def;
  if (!a.includes("=")) return true;
  return a.slice(name.length + 3);
}

const SLUG          = flag("slug");
const TOP           = parseInt(flag("top", "36"), 10);
const CANDIDATES    = parseInt(flag("candidates", "400"), 10);
const MAX_PER_BRAND = parseInt(flag("max-per-brand", "4"), 10);
const APPLY         = !!flag("apply");
const KEEP          = String(flag("keep", "")).split(",").map((s) => s.trim()).filter(Boolean);

if (!SLUG) { console.error("Missing --slug=<edit-slug>"); process.exit(1); }

// ── Aesthetic prompts per edit ────────────────────────────────────────────────
// FashionCLIP encodes each prompt to a 512-d vector; we average them so the
// edit isn't anchored to one phrasing. Negatives are not subtracted (text is
// noisy for that) — we filter unwanted items via the post-query stage instead.

const AESTHETICS = {
  "old-money": {
    title:    "Old Money",
    subtitle: "Tweed, cashmere, pleated wool, polo, loafers, pearls",
    prompts: [
      "old money fashion, ralph lauren style, equestrian, the hamptons, navy blazer with gold buttons",
      "cashmere twin set, pleated wool midi skirt, pearl necklace, leather penny loafers",
      "preppy heritage clothing, tweed jacket, herringbone wool, fair isle cardigan",
      "country club tennis whites, polo shirt with collar, knife pleated skirt, sweater tied around shoulders",
      "tailored camel coat, ivory silk blouse, oxford button-down shirt, brown leather riding boots",
      "quiet luxury, refined neutral palette, understated heritage tailoring, no logos",
    ],
    excludeRegex: [
      // Athletic / activewear (logo tennis skirts, branded sportwear)
      /\b(athletic|sport|sportswear|activewear|gym|workout|yoga|run(?:ning)?|race)\b/,
      // Sheer / lingerie / bralette
      /\b(sheer|mesh|bralette|lingerie|bodysuit|thong|g-string|micro)\b/,
      // Streetwear / hype
      /\b(graphic|logo\s+(?:tee|cap|hoodie|sweatshirt)|hoodie|sweatshirt|jogger|track\s*pant|hype|streetwear|skate|moto|biker)\b/,
      // Going-out / festival / club
      /\b(sequin|glitter|metallic|rhinestone|cutout|cut[-\s]out|backless|halter\s*neck|bustier|corset)\b/,
      // Boho / festival / Y2K
      /\b(boho|crochet|fringe|tie[-\s]dye|tiedye|patchwork|y2k|baby[-\s]?tee|micro\s*mini)\b/,
      // Resort / swim
      /\b(bikini|swimsuit|swim\s*(?:top|bottom|brief|set|wear|suit)|tankini|sarong|kaftan|caftan|pareo|cover[-\s]?up|board\s*short)\b/,
      // Novelty / kitsch / costume
      /\b(novelty|costume|halloween|holiday|christmas|santa|elf|reindeer|pumpkin|character|cartoon|emoji)\b/,
      // Wallet/clip/headband-shaped/hat that just happens to mention old-money words
      /\b(wallet|key\s*chain|jaw\s*clip|hair\s*clip|headband|sock|tights|stocking|underwear|bra\b)\b/,
      // Floppy / weird hats
      /\b(floppy|bucket\s*hat|trucker|dad\s*cap|baseball\s*cap)\b/,
      // Kids / pet / baby
      /\b(baby|infant|toddler|kids|children|girl\s|boy\s|maternity|nursing|pet|dog\b|cat\b|puppy|kitten)\b/,
      // Housewares
      /\b(washcloth|napkin|placemat|towel|doormat|soap|candle|blanket|pillow|throw|curtain|mug|glass|cup\b|bowl)\b/,
      // Gift cards
      /\b(gift\s*card|giftcard|e-gift|tarjeta\s*regalo)\b/,
      // Tennis dress with synthetic athletic build
      /tennis\s+(?:dress|skort).*\b(racer|mesh|removable|fixe|brand)\b/,
    ],
    // Categories considered for old money. "other" often means accessories,
    // hair clips, jewelry — high false-positive rate, so exclude unless the
    // brand is jewelry-only.
    allowedCategories: new Set(["top", "bottom", "dress", "jacket", "shoes"]),
    // Pearl jewelry from select brands is genuinely old-money — opt them in
    // even when category is "other" or "bag".
    jewelryAllowlistBrands: new Set([]),
  },
};

const aesthetic = AESTHETICS[SLUG];
if (!aesthetic) { console.error(`No aesthetic defined for --slug=${SLUG}. Add one to AESTHETICS.`); process.exit(1); }

// ── FashionCLIP text encoder ──────────────────────────────────────────────────

let _tokenizer, _textModel;
async function loadTextModel() {
  const { env, CLIPTextModelWithProjection, AutoTokenizer } = await import("@xenova/transformers");
  env.allowLocalModels = false;
  env.cacheDir = "./.cache/transformers";
  console.log(`Loading ${MODEL_ID} text encoder…`);
  [_tokenizer, _textModel] = await Promise.all([
    AutoTokenizer.from_pretrained(MODEL_ID),
    CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { quantized: true }),
  ]);
  console.log("Text model ready.");
}

function l2norm(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

async function encodeTexts(prompts) {
  const out = [];
  for (const p of prompts) {
    const inputs = await _tokenizer(p, { padding: true, truncation: true });
    const { text_embeds } = await _textModel(inputs);
    const v = Array.from(text_embeds.data);
    out.push(l2norm(v));
  }
  return out;
}

function meanVector(vectors) {
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  for (let i = 0; i < dim; i++) sum[i] /= vectors.length;
  return l2norm(sum);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await loadTextModel();

  console.log(`\nEncoding ${aesthetic.prompts.length} prompts and averaging…`);
  const promptVectors = await encodeTexts(aesthetic.prompts);
  const queryVector   = meanVector(promptVectors);

  console.log(`\nQuerying Pinecone for top ${CANDIDATES} candidates in "${PINECONE_INDEX}"…`);
  const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
  const index    = pinecone.index(PINECONE_INDEX);
  const result   = await index.query({
    vector:          queryVector,
    topK:            CANDIDATES,
    includeMetadata: true,
    includeValues:   false,
  });
  const matches = result.matches ?? [];
  console.log(`Got ${matches.length} candidates.`);

  // Pull full Algolia records for each candidate (for filtering + brand cap).
  const algolia = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);
  console.log(`\nFetching full records from Algolia…`);
  const ids = matches.map((m) => m.id);
  const records = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const res = await algolia.getObjects({
      requests: chunk.map((objectID) => ({
        indexName: ALGOLIA_INDEX,
        objectID,
        attributesToRetrieve: ["objectID", "title", "brand", "category", "price", "color", "description", "image_url"],
      })),
    });
    for (const r of res.results) if (r) records.push(r);
  }
  console.log(`Got ${records.length}/${ids.length} from Algolia.`);

  // Build a map for quick lookup by objectID, preserving Pinecone score order.
  const byId = new Map(records.map((r) => [r.objectID, r]));

  // ── Filter ──────────────────────────────────────────────────────────────────

  const dropReasons = {};
  function bump(reason) { dropReasons[reason] = (dropReasons[reason] ?? 0) + 1; }

  const survivors = [];
  for (const m of matches) {
    const p = byId.get(m.id);
    if (!p) { bump("no-algolia-record"); continue; }

    const text = `${p.title ?? ""} ${p.description ?? ""} ${p.color ?? ""}`.toLowerCase();

    if (!aesthetic.allowedCategories.has(p.category) &&
        !aesthetic.jewelryAllowlistBrands.has(p.brand)) {
      bump(`category:${p.category}`);
      continue;
    }

    let rejected = false;
    for (const re of aesthetic.excludeRegex) {
      if (re.test(text)) { bump(`excl:${re.source.slice(0,30)}`); rejected = true; break; }
    }
    if (rejected) continue;

    survivors.push({ ...p, score: m.score });
  }
  console.log(`\nAfter filtering: ${survivors.length} survivors`);
  console.log("Top drop reasons:");
  for (const [r, n] of Object.entries(dropReasons).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${n.toString().padStart(4)} ${r}`);
  }

  // ── Brand cap + take top N ─────────────────────────────────────────────────

  const perBrand = new Map();
  const picks = [];
  // Reserve KEEP ids first so they're preserved with brand-cap counted.
  for (const id of KEEP) {
    const p = byId.get(id);
    if (!p) continue;
    perBrand.set(p.brand, (perBrand.get(p.brand) ?? 0) + 1);
    picks.push({ ...p, score: 1, kept: true });
  }
  for (const p of survivors) {
    if (picks.length >= TOP) break;
    if (KEEP.includes(p.objectID)) continue;
    const n = perBrand.get(p.brand) ?? 0;
    if (n >= MAX_PER_BRAND) continue;
    perBrand.set(p.brand, n + 1);
    picks.push(p);
  }

  console.log(`\nFinal selection: ${picks.length}/${TOP}`);
  console.log("Brand mix:");
  for (const [b, n] of [...perBrand.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(b ?? "?").padEnd(28)} ${n}`);
  }
  console.log("\nAll picks:");
  for (const p of picks) {
    const tag = p.kept ? "KEEP " : `${p.score.toFixed(3)}`;
    console.log(`  [${tag}] [${p.category.padEnd(7)}] ${(p.brand ?? "?").padEnd(20)} $${(p.price || 0).toString().padStart(4)}  ${(p.title ?? "").slice(0, 55)}`);
  }

  if (!APPLY) {
    console.log("\n--apply not set; not writing edits.json. Re-run with --apply to commit picks.");
    return;
  }

  // ── Apply to edits.json ────────────────────────────────────────────────────

  const editsPath = "content/edits.json";
  const edits = JSON.parse(readFileSync(editsPath, "utf8"));
  const target = edits.find((e) => e.slug === SLUG);
  if (!target) { console.error(`No edit found with slug=${SLUG}`); process.exit(1); }

  target.product_ids = picks.map((p) => p.objectID);
  target.subtitle    = aesthetic.subtitle;
  // Bump published_at so any "recent edits" UI reflects the refresh.
  target.published_at = new Date().toISOString().slice(0, 10);

  writeFileSync(editsPath, JSON.stringify(edits, null, 2) + "\n");
  console.log(`\n✓ Wrote ${picks.length} picks to ${editsPath} (slug=${SLUG}).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
