import Anthropic from "@anthropic-ai/sdk";
import {
  searchByCategory,
  searchByMultipleQueries,
  searchProducts,
  type AlgoliaProduct,
  type CategoryCandidates,
  type ClothingCategory,
} from "@/lib/algolia";
import type { StyleDNA, ClickSignal, VisionImage, QuestionnaireAnswers } from "@/lib/types";
import { logCuration } from "@/lib/curation-log";

// Re-export so consumers can import from either place
export type {
  StyleDNA,
  StyleReference,
  CategoryQueries,
  ClickSignal,
  VisionImage,
  QuestionnaireAnswers,
} from "@/lib/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Anthropic's vision endpoint rejects many-image requests where any single
// image exceeds 2000px in either dimension. Shopify's raw CDN URLs commonly
// serve originals at 2400–3000px, so we rewrite them to a safe 1600px on the
// way to Claude. Non-Shopify URLs are passed through — most other catalogs
// already serve under 2000px and we don't have a universal resize idiom.
//
// Works for: https://cdn.shopify.com/... and brand-domain Shopify mirrors.
// The `width` param is Shopify's documented image transform; the CDN returns
// 200 with the resized file whether or not an existing query string is set.
function sizeImageUrl(url: string, maxDim = 1600): string {
  if (typeof url !== "string" || !url.startsWith("http")) return url;
  if (!/cdn\.shopify\.com/i.test(url)) return url;
  // Don't double-size if someone already set width/height.
  if (/[?&](width|height)=/i.test(url)) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}width=${maxDim}&height=${maxDim}`;
}

// ── Types local to ai.ts ──────────────────────────────────────────────────────

export type AestheticProfile = StyleDNA;

export type OutfitGroup = "outfit_a" | "outfit_b";

export interface CuratedProduct extends AlgoliaProduct {
  style_note:   string;
  outfit_role:  string;
  outfit_group: OutfitGroup;
  how_to_wear:  string;
}

export interface CurationResult {
  products:        CuratedProduct[];
  editorial_intro: string;
  edit_rationale:  string;
  // Outfit narrative arc
  outfit_arc:    string;  // e.g. "day / night"
  outfit_a_role: string;  // e.g. "the unhurried Sunday morning"
  outfit_b_role: string;  // e.g. "the same energy, after dark"
}

// ── Client ────────────────────────────────────────────────────────────────────

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

type SupportedMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const SUPPORTED_MIMES = new Set<string>(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function toImageBlocks(images: VisionImage[], maxCount = 12) {
  return images
    .filter((img) => SUPPORTED_MIMES.has(img.mimeType))
    .slice(0, maxCount)
    .map((img) => ({
      type: "image" as const,
      source: {
        type:        "base64" as const,
        media_type:  img.mimeType as SupportedMime,
        data:        img.base64,
      },
    }));
}

// ── Step 1: Aesthetic analysis — synthesises board images + taste history ─────

const JSON_SCHEMA_TEMPLATE = `{
  "primary_aesthetic": "specific named aesthetic — feminine OR masculine OR androgynous. Examples span the spectrum: 'quiet luxury minimalist', 'coastal grandmother', 'dad-core chic', 'workwear utilitarian', 'old money prep', 'gorpcore', 'menswear-inspired tailoring', 'street goth', 'clean girl', 'preppy ivy'",
  "secondary_aesthetic": "secondary influence, e.g. 'with Parisian casual undertones', 'with skater edge', 'with vintage workwear sensibility'",
  "color_palette": ["5-6 very specific color names — e.g. 'warm ivory', 'dusty sage', 'caramel', 'slate blue' — never just 'beige' or 'blue'"],
  "silhouettes": ["4-5 silhouette preferences spanning the gender spectrum as the brief demands — e.g. 'relaxed wide-leg trouser', 'oversized boxy top', 'baggy carpenter pant', 'cropped boxy tee', 'flowy bias-cut midi'"],
  "key_pieces": ["5-6 specific hero garments — match the brief's gender coding, do not default to feminine. Masculine-coded brief examples: 'oversized graphic tee', 'baggy carpenter pants', 'pleated wool trouser', 'oxford button-down', 'chore jacket', 'dad cap', 'leather penny loafer'. Feminine: 'linen wrap dress', 'structured leather blazer', 'bias-cut slip skirt'. Androgynous: 'cashmere crewneck', 'straight-leg denim', 'tailored blazer'"],
  "avoids": ["3-4 CONCRETE visual avoids — things FashionCLIP can recognize in an image. Good: 'neon colors', 'logos', 'sequins', 'sheer fabric', 'puff sleeves'. Bad: 'overly formal', 'too trendy' (these are abstract and steer the vector search badly — skip them)"],
  "occasion_mix": { "casual": 40, "work": 20, "weekend": 30, "going_out": 10 },
  "price_range": "budget | mid | luxury",
  "mood": "3-4 words, understated and specific, e.g. 'unhurried, a little cinematic'",
  "summary": "2-3 sentences in a quiet, knowing editorial voice. No hype, no em dashes, no superlatives. Write like a friend who really gets it, not a press release.",
  "style_keywords": ["8-10 specific searchable fashion terms"],
  "style_references": [
    { "name": "celebrity or cultural figure name", "era": "specific era and context", "why": "one sentence on why this reference fits this exact board" },
    { "name": "...", "era": "...", "why": "..." }
  ],
  "category_queries": {
    "IMPORTANT": "Queries must match how products are titled in a retail catalogue. Short. Simple. Color + type. NOT descriptive sentences. ALSO: it is OK and PREFERRED to leave a category as an EMPTY ARRAY [] when it doesn't fit the brief. A masculine brief should have empty 'dress'. A swimwear brief should have empty 'jacket'. Padding categories with off-brief queries pollutes the results.",
    "dress": ["0-3 queries, MAX 3 words each. EMPTY ARRAY if the brief is masculine, athletic, or otherwise dress-incompatible. Otherwise: 'black midi dress', 'ivory slip dress', 'floral mini dress'"],
    "top": ["0-3 queries, MAX 3 words each. Span gender as needed: feminine 'cream knit top', 'white blouse'; masculine 'oversized graphic tee', 'oxford shirt', 'crew sweatshirt'"],
    "bottom": ["0-3 queries, MAX 3 words each. Feminine: 'black mini skirt'. Masculine: 'baggy carpenter pant', 'wide leg trouser', 'cargo pants'. Mixed: 'straight leg denim'"],
    "jacket": ["0-3 queries, MAX 3 words each. Feminine: 'camel coat'. Masculine: 'chore jacket', 'work jacket', 'bomber jacket', 'varsity jacket'. Both: 'black blazer', 'leather jacket'"],
    "shoes": ["0-3 queries, MAX 3 words each. Feminine: 'black heels', 'tan sandals'. Masculine/unisex: 'penny loafer', 'work boot', 'white sneakers', 'dad sneaker', 'chelsea boot'"],
    "bag": ["0-3 queries, MAX 3 words each. Feminine: 'mini shoulder bag'. Masculine/unisex: 'leather messenger', 'canvas tote', 'crossbody bag'"]
  },
  "retrieval_phrases": ["5-8 FULL descriptive sentences about ideal outfits — written in FashionCLIP's native 'a photo of ...' vocabulary: garment + fabric + color + silhouette + styling. ALWAYS prefix each with 'a photo of'. Match the brief's gender coding. Examples for dad-core: 'a photo of an oversized navy crewneck sweatshirt with baggy washed denim and white sneakers', 'a photo of a faded chore jacket layered over a white tee with relaxed straight pants'. Examples for old money: 'a photo of a chunky cream cable-knit turtleneck with pleated midi skirt in dove gray', 'a photo of an oversized camel wool trench coat belted at the waist'. Each phrase = ONE complete visual the wearer would actually want."],
  "focus_categories": "OPTIONAL array of category names. Set this whenever the brief is gender-coded or category-coded such that some categories don't apply. A masculine 'dad-core' or 'workwear' brief -> ['top','bottom','jacket','shoes']. A swim board -> [] is fine but better to set ['dress'] only if it's a sundress brief, otherwise leave open. A shoes-only board -> ['shoes']. When set, only those categories will be retrieved — this PROTECTS the brief from being polluted by off-aesthetic dress matches. Set conservatively but DO USE IT for gender-coded text briefs."
}`;

function buildHistoryBlock(previousDNAs: StyleDNA[]): string {
  if (!previousDNAs.length) return "";
  const entries = previousDNAs
    .slice(0, 5)
    .map((dna) => {
      const name = dna._boardName ?? "previous board";
      return (
        `Board: "${name}"\n` +
        `  Aesthetic: ${dna.primary_aesthetic}${dna.secondary_aesthetic ? ` — ${dna.secondary_aesthetic}` : ""}\n` +
        `  Palette: ${(dna.color_palette ?? []).join(", ")}\n` +
        `  Key pieces: ${(dna.key_pieces ?? []).join(", ")}\n` +
        `  Avoids: ${(dna.avoids ?? []).join(", ")}\n` +
        `  Mood: ${dna.mood}`
      );
    })
    .join("\n\n");

  return (
    `TASTE HISTORY — what we already know about this person from ${previousDNAs.length} previous board${previousDNAs.length > 1 ? "s" : ""}:\n\n` +
    entries +
    `\n\nThis new board either ADDS a new dimension, REFINES what we know, or CONTRADICTS something. ` +
    `The StyleDNA you return must synthesise ALL of this — not just analyse the new board in isolation. ` +
    `If patterns repeat across boards, strengthen them. If this board contradicts a previous one, note the tension in 'summary'.`
  );
}

/**
 * Per-pin metadata passed into analyzeAesthetic — the richer Pinterest API
 * fields that give Claude much better vibe context than title + description.
 */
export interface PinMetadata {
  title?:          string;
  description?:    string;
  altText?:        string;
  link?:           string;
  domain?:         string;
  dominantColors?: string[];
}

/**
 * Board-level metadata — source domains, board description, etc.
 * `sourceDomains` is the biggest signal: it tells Claude the style tribe
 * (ssense.com ≠ shopbop.com ≠ princesspolly.com).
 */
export interface BoardMetadata {
  description?:  string;
  sourceDomains?: string[];
}

/**
 * PASS 1 — Vision: describe each pin individually with fashion vocabulary.
 * Returns one description per image, in order. Sonnet does the heavy lifting.
 */
async function describePinsIndividually(
  images:  VisionImage[],
  pinMeta: PinMetadata[],
): Promise<string[]> {
  if (images.length === 0) return [];
  const client = getClient();

  const metaLines = images.map((_, i) => {
    const m = pinMeta[i] ?? {};
    const parts = [
      m.title      && `title: "${m.title}"`,
      m.altText    && `alt: "${m.altText.slice(0, 120)}"`,
      m.description && `desc: "${m.description.slice(0, 120)}"`,
      m.domain     && `source: ${m.domain}`,
      m.dominantColors && m.dominantColors.length > 0 && `colors: ${m.dominantColors.slice(0, 3).join(", ")}`,
    ].filter(Boolean);
    return `Pin ${i + 1}: ${parts.length > 0 ? parts.join(" | ") : "(no metadata)"}`;
  }).join("\n");

  const prompt = `You are a fashion editor. I'm going to show you ${images.length} Pinterest pins. For each one, write a precise 1-2 sentence description focused on:
- Garment types and silhouettes (be specific: "A-line bias-cut midi dress", not "dress")
- Fabrics and textures (silk, linen, wool, lace, knit — include weave/weight when visible)
- Specific colors ("burnt sienna", "dove gray", "oxblood" — never just "red" or "gray")
- Styling (layering, proportions, how the garment is worn)
- Era or cultural reference if clear (1970s YSL, 90s minimalism, Parisian, Japanese avant-garde, etc.)

Pin metadata (use it to sharpen your reading — especially the source domain, which signals price tier and style tribe):

${metaLines}

Return a numbered list with one line per pin. No preamble. No summary. No em dashes. Just:
1. <description>
2. <description>
...`;

  const userContent: Anthropic.MessageParam["content"] = [
    ...toImageBlocks(images),
    { type: "text" as const, text: prompt },
  ];

  // Haiku 4.5 has vision and is ~3–4× faster than Sonnet for multi-image
  // reads. The synthesis pass (pass 2) does all the pattern-matching, so
  // pass 1 only needs "accurate per-image descriptions" — a task where
  // Haiku is competitive and the latency win (~6–10 s on a 12-image board)
  // is material to the user's perceived loading time.
  const message = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 2200,
    messages:   [{ role: "user", content: userContent }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  // Parse numbered lines (allow "1." or "1)" etc.)
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => /^\d+[.)]/.test(l));
  return lines.map((l) => l.replace(/^\d+[.)]\s*/, ""));
}

/**
 * PASS 2 — Text synthesis: pattern-match across the per-pin descriptions
 * (plus board metadata + source domains) to produce the final StyleDNA.
 * No vision needed — cheap and fast on Haiku.
 */
async function synthesizeStyleDNA(
  boardName:       string,
  pinDescriptions: string[],
  boardMeta:       BoardMetadata,
  previousDNAs:    StyleDNA[],
  extraContext?:   string,
): Promise<StyleDNA> {
  const client = getClient();
  const historyBlock = buildHistoryBlock(previousDNAs);

  const pinText = pinDescriptions
    .slice(0, 40)
    .map((d, i) => `${i + 1}. ${d}`)
    .join("\n");

  const domainsBlock = boardMeta.sourceDomains && boardMeta.sourceDomains.length > 0
    ? `\nPin source domains (tells you price tier + style tribe — e.g. ssense/matchesfashion = luxury editorial, shopbop/revolve = contemporary, princesspolly/shein = fast fashion):\n${boardMeta.sourceDomains.join(", ")}\n`
    : "";

  const boardDescBlock = boardMeta.description
    ? `\nUser's board description: "${boardMeta.description}"\n`
    : "";

  const promptText =
    `You are a fashion editor with a sharp, quiet eye. You identify aesthetics with precision, not hype.\n` +
    (historyBlock ? `\n${historyBlock}\n` : "") +
    `\nA user pinned these items to a Pinterest board called "${boardName}".${boardDescBlock}${domainsBlock}\n\n` +
    `Here are precise descriptions of each pin (already analyzed from the images):\n\n${pinText}\n\n` +
    (extraContext ? `Additional user context:\n${extraContext}\n\n` : "") +
    `Look for patterns across the pins — what repeats, what the underlying aesthetic subculture is. Synthesize into a StyleDNA. ` +
    `Be specific and exact. No filler, no em dashes, no superlatives. Return ONLY valid JSON:\n\n${JSON_SCHEMA_TEMPLATE}`;

  const message = await client.messages.create({
    // Text-only synthesis — Haiku is plenty for this and is ~4x faster/cheaper
    // than the Sonnet vision pass above.
    model:      "claude-haiku-4-5",
    max_tokens: 2500,
    messages:   [{ role: "user", content: promptText }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  return JSON.parse(json) as StyleDNA;
}

export async function analyzeAesthetic(
  boardName:       string,
  pinDescriptions: string[],
  images:          VisionImage[]  = [],
  previousDNAs:    StyleDNA[]     = [],
  extraContext?:   string,
  pinMeta:         PinMetadata[]  = [],
  boardMeta:       BoardMetadata  = {},
): Promise<StyleDNA> {
  // No images → skip pass 1, run pass 2 directly on whatever descriptions
  // the caller already provided (title + description concatenated).
  if (images.length === 0) {
    const descriptions = pinDescriptions.filter((d) => d.trim().length > 0);
    return synthesizeStyleDNA(boardName, descriptions, boardMeta, previousDNAs, extraContext);
  }

  // Two-pass: Sonnet vision per-pin → Haiku text synthesis.
  // Runs pass 1 (describe) and then pass 2 (synthesize) serially because
  // pass 2 depends on pass 1's output.
  const perPinDescriptions = await describePinsIndividually(images, pinMeta);
  // Also include any caller-provided text descriptions not covered by images
  const extraDescriptions  = pinDescriptions
    .slice(images.length)
    .filter((d) => d.trim().length > 0);
  const allDescriptions = [...perPinDescriptions, ...extraDescriptions];

  return synthesizeStyleDNA(boardName, allDescriptions, boardMeta, previousDNAs, extraContext);
}

// ── Step 2a: Fetch candidates ─────────────────────────────────────────────────

export async function fetchCandidateProductsByCategory(
  dna:        StyleDNA,
  userToken?: string
): Promise<CategoryCandidates> {
  const queries = dna.category_queries;

  if (!queries) {
    const flat = await searchByMultipleQueries(
      dna.style_keywords.slice(0, 8),
      dna.style_keywords,
      dna.price_range,
      20,
      userToken
    );
    const chunk = Math.ceil(flat.length / 6);
    return {
      dress:  flat.slice(0, chunk),
      top:    flat.slice(chunk, chunk * 2),
      bottom: flat.slice(chunk * 2, chunk * 3),
      jacket: flat.slice(chunk * 3, chunk * 4),
      shoes:  flat.slice(chunk * 4, chunk * 5),
      bag:    flat.slice(chunk * 5),
    };
  }

  // Supplement Claude's queries with simple [color] + [type] fallbacks.
  // Channel3 titles are short (e.g. "Black Viscose Blend Dress") so overly
  // descriptive queries miss inventory. Simple color + type always hits something.
  //
  // CRITICAL: only augment categories Claude actually populated. If Claude
  // returned `dress: []` for a masculine "dad-core" brief, padding with
  // `"olive dress", "navy dress"` etc would re-pollute the very category we
  // wanted suppressed. Empty stays empty.
  const baseColors = (dna.color_palette ?? [])
    .slice(0, 4)
    .map((c) => c.toLowerCase().split(" ").pop() ?? c)   // "dusty sage" → "sage"
    .filter((c) => c.length > 2 && !/^\d/.test(c));

  function augment(cat: ClothingCategory, terms: string[]): string[] {
    const seed = queries[cat] ?? [];
    if (seed.length === 0) return [];                 // honor explicit empties
    return [...seed, ...baseColors.flatMap((c) => terms.map((t) => `${c} ${t}`))];
  }

  const augmented: Record<ClothingCategory, string[]> = {
    dress:  augment("dress",  ["dress"]),
    top:    augment("top",    ["top"]),
    bottom: augment("bottom", ["skirt", "pants"]),
    jacket: augment("jacket", ["blazer", "coat"]),
    shoes:  augment("shoes",  ["heels", "boots"]),
    bag:    augment("bag",    ["bag"]),
  };

  const result = await searchByCategory(
    augmented,
    dna.style_keywords,
    dna.price_range,
    50,           // 6 categories × 50 = 300 raw → ~250 after filters,
                  // matches the hybridSearch cap and the CLIP centroid
                  // topK = 300 the rest of the pipeline is sized around.
                  // Was 20 (→ ~70 after filters), too tight for any
                  // post-Algolia diversity work.
    userToken
  );

  // Emergency guarantee: if we have very few products with images across all categories,
  // supplement with simple palette-color searches that reliably match the available inventory.
  // Hello Molly (our best-image retailer) titles look like "Flirt Hour Mini Dress Red" —
  // so "red dress", "black dress", "midi dress" always work; aesthetic keywords don't.
  //
  // When focus_categories is set, pad THAT category instead of always dresses —
  // otherwise a shoes board with thin Algolia matches falls back to dresses,
  // exactly the bug focus_categories exists to prevent.
  const cats: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];
  const total = cats.reduce((s, c) => s + result[c].length, 0);

  if (total < 6) {
    const existingIds = new Set(cats.flatMap((c) => result[c].map((p) => p.objectID)));

    const focus = (dna.focus_categories ?? []).filter(
      (c): c is ClothingCategory => cats.includes(c as ClothingCategory),
    );
    const padCat: ClothingCategory = focus[0] ?? "dress";

    const baseColors = (dna.color_palette ?? [])
      .slice(0, 4)
      .map((c) => c.toLowerCase().split(" ").pop() ?? c)
      .filter((c) => c.length > 2);

    const silhouetteWords = (dna.silhouettes ?? [])
      .slice(0, 2)
      .map((s) => s.toLowerCase().split(" ").pop() ?? s);

    // Per-category generic fallback term. "midi dress" works; "midi shoes"
    // doesn't — so use the right generic for the focus category.
    const genericByCat: Record<ClothingCategory, string[]> = {
      dress:  ["midi dress", "mini dress"],
      top:    ["white top", "black top"],
      bottom: ["black pants", "denim jean"],
      jacket: ["black blazer", "tan coat"],
      shoes:  ["black heels", "white sneakers", "tan sandals"],
      bag:    ["black bag", "tan tote"],
    };

    const fallbackQueries = [
      ...baseColors.map((c) => `${c} ${padCat}`),
      ...silhouetteWords.map((s) => `${s} ${padCat}`),
      ...genericByCat[padCat],
    ];

    for (const q of fallbackQueries) {
      if (result[padCat].length >= 8) break;
      const extras = await searchProducts(q, [], dna.price_range, 6, undefined, userToken).catch(() => [] as AlgoliaProduct[]);
      for (const p of extras) {
        if (!existingIds.has(p.objectID)) {
          existingIds.add(p.objectID);
          result[padCat].push(p);
        }
      }
    }
  }

  return result;
}

// ── Step 2b-pre: Focus-category skew ─────────────────────────────────────────
//
// When Claude flags the input as single-category (e.g. 100+ pins on a
// dedicated shoes board → focus_categories=['shoes']), drop every
// non-focus bucket entirely. The earlier attempt kept 3 complementary
// pieces per non-focus category for "outfit context," but in practice
// it let a stray pink floral dress land in a 100% shoes board feed —
// exactly the kind of mismatch the signal was meant to eliminate. If
// the user wanted dresses they'd have pinned dresses. Zero tolerance.
//
// Applied AFTER retrieval (Algolia or hybrid), BEFORE avoid / mens
// filtering. No-op when focus_categories is empty or undefined (the
// common mixed-lookbook case — balanced across all six categories).
//
// Belt + braces: even the focus bucket gets passed through a title
// keyword blocker because the Algolia index occasionally has products
// mis-tagged (a dress filed under category:"shoes"). The blocker
// rejects items whose titles strongly contradict the bucket — so a
// "Floral Midi Dress" with category:"shoes" in Algolia won't surface
// in a shoes-focused feed even though the category field lied.

const NON_FOCUS_CAP = 0; // no complementary pieces — strict focus

// Title-keyword contradiction list per clothing category. If a product
// purports to be (say) shoes but its title contains "dress", "bag",
// "earring", etc., we drop it. Mirrors CATEGORY_BLOCKERS in
// app/api/shop-all/route.ts but keyed by internal ClothingCategory
// instead of the public /shop-all labels.
const CATEGORY_TITLE_BLOCKERS: Record<ClothingCategory, readonly string[]> = {
  dress:  ["shoe", "boot", "sandal", "heel", "sneaker", "loafer", "pump", "pant", "jean", "trouser", "bag", "tote", "handbag", "clutch", "jacket", "coat", "blazer", "necklace", "bracelet", "ring", "earring"],
  top:    ["shoe", "boot", "sandal", "heel", "sneaker", "loafer", "pump", "pant", "skirt", "dress", "jean", "trouser", "bag", "tote", "handbag", "clutch", "necklace", "bracelet", "ring", "earring"],
  bottom: ["shoe", "boot", "sandal", "heel", "sneaker", "loafer", "pump", "dress", "shirt", "blouse", "top", "tee", "tank", "jacket", "coat", "blazer", "bag", "tote", "handbag", "clutch", "necklace", "bracelet", "ring", "earring"],
  jacket: ["shoe", "boot", "sandal", "heel", "sneaker", "loafer", "pump", "dress", "gown", "skirt", "short", "jean", "trouser", "bag", "tote", "handbag", "clutch", "necklace", "bracelet", "ring", "earring"],
  shoes:  ["hoody", "hoodie", "sweater", "sweatshirt", "cardigan", "jumper", "shirt", "blouse", "tee", "tank", "dress", "gown", "pant", "skirt", "short", "jean", "trouser", "jacket", "coat", "blazer", "bag", "tote", "handbag", "clutch", "necklace", "bracelet", "ring", "earring", "belt", "hat", "cap", "scarf"],
  bag:    ["shoe", "boot", "sandal", "heel", "sneaker", "pant", "skirt", "dress", "shirt", "blouse", "jacket", "coat", "necklace", "bracelet", "ring", "earring"],
};

function passesCategoryBlocker(p: AlgoliaProduct, cat: ClothingCategory): boolean {
  const blockers = CATEGORY_TITLE_BLOCKERS[cat];
  if (!blockers) return true;
  const title = String(p.title ?? "").toLowerCase();
  // Word-boundary match so "heel" doesn't match "heelless" and so on.
  return !blockers.some((k) => new RegExp(`\\b${k}`, "i").test(title));
}

export function applyFocusSkew(
  candidates: CategoryCandidates,
  focusCategories: string[] | undefined,
): CategoryCandidates {
  if (!focusCategories || focusCategories.length === 0) return candidates;
  const focus = new Set(focusCategories.map((c) => c.toLowerCase().trim()));
  const cats: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];
  const out: CategoryCandidates = {
    dress:  candidates.dress,
    top:    candidates.top,
    bottom: candidates.bottom,
    jacket: candidates.jacket,
    shoes:  candidates.shoes,
    bag:    candidates.bag,
  };
  for (const cat of cats) {
    if (!focus.has(cat)) {
      out[cat] = out[cat].slice(0, NON_FOCUS_CAP);
    } else {
      // Focus bucket — enforce title blocker on top of the category filter
      // so mis-tagged products can't sneak in.
      out[cat] = out[cat].filter((p) => passesCategoryBlocker(p, cat));
    }
  }
  return out;
}

// ── Step 2b-pre: Hard gender filter — runs before any AI call ────────────────
// Catches "Mens Gold Blazer", "Men's Coat", "boys hoodie" etc. by title/description.
// Also checks the `gender` field if the importer stored it.

const MENS_RE = /\b(mens?|men['']s|boys?|boy['']s|for\s+him)\b/i;

export function filterMensItems(candidates: CategoryCandidates): CategoryCandidates {
  const filter = (pool: AlgoliaProduct[]) =>
    pool.filter((p) => {
      // Check stored gender field (populated by Channel3 importer)
      if ((p as AlgoliaProduct & { gender?: string }).gender === "male") return false;
      // Check title + first 120 chars of description
      const text = `${p.title ?? ""} ${(p.description ?? "").slice(0, 120)}`;
      return !MENS_RE.test(text);
    });
  return {
    dress:  filter(candidates.dress),
    top:    filter(candidates.top),
    bottom: filter(candidates.bottom),
    jacket: filter(candidates.jacket),
    shoes:  filter(candidates.shoes),
    bag:    filter(candidates.bag),
  };
}

// ── Step 2b: Avoids filter ────────────────────────────────────────────────────

function extractAvoidKeywords(avoids: string[]): string[] {
  const all = avoids.flatMap((phrase) =>
    phrase.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w) => w.length > 3)
  );
  return Array.from(new Set(all));
}

function hitsAvoid(product: AlgoliaProduct, keywords: string[]): boolean {
  const haystack = [product.title, product.description, product.material, product.color,
    ...(product.aesthetic_tags ?? [])].join(" ").toLowerCase();
  return keywords.some((kw) => haystack.includes(kw));
}

export function filterByAvoids(
  candidates: CategoryCandidates,
  avoids:     string[]
): CategoryCandidates {
  if (!avoids?.length) return candidates;
  const keywords = extractAvoidKeywords(avoids);
  if (!keywords.length) return candidates;
  const filter = (pool: AlgoliaProduct[]) => pool.filter((p) => !hitsAvoid(p, keywords));
  return {
    dress:  filter(candidates.dress),
    top:    filter(candidates.top),
    bottom: filter(candidates.bottom),
    jacket: filter(candidates.jacket),
    shoes:  filter(candidates.shoes),
    bag:    filter(candidates.bag),
  };
}

// (shortlistCandidates removed — we go straight to image-first outfit build)

async function _unused_shortlistCandidates(
  dna:         StyleDNA,
  candidates:  CategoryCandidates,
  client:      Anthropic,
  boardImages: VisionImage[] = []
): Promise<CategoryCandidates> {
  const categories: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];

  // ── Build image-keyed product list ────────────────────────────────────────
  // Send every product that has an image URL (up to 8 per category = 48 max).
  // Claude will judge PRIMARILY by image — text is only supplementary context.
  // Products without images fall back to text-only rows at the end.

  type Entry = { cat: ClothingCategory; idx: number; product: AlgoliaProduct; imgSlot: number | null };
  const entries: Entry[] = [];
  const productImgBlocks: Array<{ type: "image"; source: { type: "url"; url: string } }> = [];

  for (const cat of categories) {
    candidates[cat].forEach((p, idx) => {
      const hasImg = p.image_url?.startsWith("http");
      if (hasImg && productImgBlocks.length < 48) {
        productImgBlocks.push({ type: "image" as const, source: { type: "url" as const, url: sizeImageUrl(p.image_url) } });
        entries.push({ cat, idx, product: p, imgSlot: productImgBlocks.length }); // 1-based
      } else {
        entries.push({ cat, idx, product: p, imgSlot: null });
      }
    });
  }

  // Human-readable image key for the prompt
  const imageKeyLines = entries
    .filter((e) => e.imgSlot !== null)
    .map((e) => `  Img ${e.imgSlot} → ${e.cat.toUpperCase()} idx ${e.idx}: "${e.product.title}" (${e.product.brand})`);

  // Text-only fallback rows (no image)
  const textOnlyLines = entries
    .filter((e) => e.imgSlot === null)
    .map((e) => `  ${e.cat.toUpperCase()} idx ${e.idx} [no image]: "${e.product.title}" — ${e.product.brand} | ${(e.product.aesthetic_tags ?? []).slice(0, 4).join(", ")} | ${e.product.price_range}`);

  const hasBoardImages   = boardImages.length > 0;
  const hasProductImages = productImgBlocks.length > 0;

  const promptText =
    `You are a senior fashion editor doing a visual first-pass for a WOMEN'S FASHION edit.` +
    (hasBoardImages ? ` The first ${boardImages.length} image(s) above are the client's Pinterest board — they define the aesthetic target.` : "") +
    (hasProductImages ? ` The next ${productImgBlocks.length} images are product photos — JUDGE PRIMARILY BY WHAT YOU SEE IN EACH IMAGE.` : "") +
    `

YOUR PRIMARY TOOL IS YOUR EYES. Look at each product image. Ask: "Does this look like it belongs in this person's world?" Texture, silhouette, drape, color, and vibe from the image outweigh anything in the text description.

HARD ELIMINATES (no exceptions):
1. Anything clearly designed for men — male model wearing it, male cut, boxy shoulder, men's blazer shape → REJECT.
2. Anything that hits the hard avoids list.

CLIENT AESTHETIC:
${dna.primary_aesthetic}${dna.secondary_aesthetic ? ` — ${dna.secondary_aesthetic}` : ""}
Palette: ${dna.color_palette.join(", ")}
Silhouettes she reaches for: ${(dna.silhouettes ?? []).join(", ")}
Key pieces: ${dna.key_pieces.join(", ")}
Hard avoids: ${dna.avoids.join(", ")}
${(dna.style_references ?? []).length ? `References: ${dna.style_references.map((r) => `${r.name} (${r.era})`).join(", ")}` : ""}

PRODUCT IMAGES (in order sent above):
${imageKeyLines.join("\n") || "  (none)"}

TEXT-ONLY PRODUCTS (no image available — judge by description):
${textOnlyLines.join("\n") || "  (none)"}

TASK: Shortlist the 8-12 visually strongest picks across all categories.
- Pick at least 1 per category that has candidates.
- Up to 4 from dress/top (those dominate the catalogue).
- Prefer image-verified picks over text-only picks.
- Be generous — capture different facets of the aesthetic (e.g. one relaxed, one sharp).

Return ONLY this JSON:
{
  "shortlist": [
    { "category": "dress", "idx": 0 },
    { "category": "top",   "idx": 1 }
  ]
}`;

  const message = await client.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 900,
    messages: [
      {
        role: "user",
        content: [
          ...toImageBlocks(boardImages, 6),
          ...productImgBlocks,
          { type: "text" as const, text: promptText },
        ],
      },
    ],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const json    = rawText.match(/\{[\s\S]*\}/)?.[0] ?? "{}";

  let parsed: { shortlist?: Array<{ category: string; idx: number }> } = {};
  try { parsed = JSON.parse(json); } catch { /* fallback below */ }

  const finalists: CategoryCandidates = { dress: [], top: [], bottom: [], jacket: [], shoes: [], bag: [] };

  for (const pick of parsed.shortlist ?? []) {
    const cat = pick.category as ClothingCategory;
    if (!categories.includes(cat)) continue;
    const product = candidates[cat][pick.idx];
    if (product && finalists[cat].length < 8) finalists[cat].push(product); // up to 8 per category → richer Stage 2 pool
  }

  // Guarantee at least 3 picks per available category (to give Stage 2 real visual choice)
  for (const cat of categories) {
    if (finalists[cat].length === 0 && candidates[cat].length > 0) {
      finalists[cat].push(...candidates[cat].slice(0, 4));
    } else if (finalists[cat].length < 3 && candidates[cat].length > finalists[cat].length) {
      const usedIds = new Set(finalists[cat].map((p) => p.objectID));
      const extras  = candidates[cat].filter((p) => !usedIds.has(p.objectID)).slice(0, 3 - finalists[cat].length);
      finalists[cat].push(...extras);
    }
  }

  return finalists;
}

// ── Step 3: Curate — direct image-first outfit build (no shortlist stage) ────
// Every product with an image is shown directly to Claude.
// Decision weight: 80% what Claude sees in the image, 20% text metadata.

export async function curateProducts(
  dna:          StyleDNA,
  candidates:   CategoryCandidates,
  boardImages:  VisionImage[]  = [],
  clickSignals: ClickSignal[]  = [],
  trendsBlock:  string         = ""
): Promise<CurationResult> {
  const categories: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];

  const totalCandidates = categories.reduce((sum, cat) => sum + candidates[cat].length, 0);
  if (totalCandidates === 0) {
    return { products: [], editorial_intro: "", edit_rationale: "", outfit_arc: "", outfit_a_role: "", outfit_b_role: "" };
  }

  const client = getClient();

  // ── Build label map + image blocks ──────────────────────────────────────────
  // Label: "DRESS-3", "TOP-0", etc. — numeric index per category.
  // Cap at 60 product images for latency (each image is ~1K tokens; 100 was
  // adding 3-5s to every curate call for limited quality lift).
  // Products without images are still listed as text so Claude knows they exist.

  type Entry = { label: string; product: AlgoliaProduct; imgSlot: number | null };
  const labelMap: Entry[] = [];
  const productImgBlocks: Array<{ type: "image"; source: { type: "url"; url: string } }> = [];

  for (const cat of categories) {
    candidates[cat].forEach((product, idx) => {
      const hasImg = product.image_url?.startsWith("http") && productImgBlocks.length < 60;
      const label  = `${cat.toUpperCase()}-${idx}`;
      if (hasImg) {
        productImgBlocks.push({ type: "image" as const, source: { type: "url" as const, url: sizeImageUrl(product.image_url) } });
        labelMap.push({ label, product, imgSlot: productImgBlocks.length }); // 1-based
      } else {
        labelMap.push({ label, product, imgSlot: null });
      }
    });
  }

  // Board images come first (up to 8), then product images
  const boardImgBlocks = toImageBlocks(boardImages, 8);
  const B = boardImgBlocks.length; // offset so product img numbers are unambiguous

  // Text catalogue — every product, with its image number or [no image]
  const catalogueText = categories.map((cat) => {
    const pool = candidates[cat];
    if (!pool.length) return null;
    const rows = pool.map((p, idx) => {
      const label   = `${cat.toUpperCase()}-${idx}`;
      const entry   = labelMap.find((e) => e.label === label);
      const imgMark = entry?.imgSlot != null ? `[Img ${B + entry.imgSlot}]` : "[no image]";
      return `  ${label} ${imgMark}: "${p.title}" — ${p.brand} | ${p.color || "?"} | ${(p.material || "").slice(0, 50)} | ${p.price_range} | ${p.retailer}`;
    }).join("\n");
    return `${cat.toUpperCase()}:\n${rows}`;
  }).filter(Boolean).join("\n\n");

  const clickBlock = clickSignals.length > 0
    ? `CONFIRMED TASTE SIGNALS — products this person clicked before (proven preference, not aspiration):\n` +
      clickSignals.slice(0, 8).map((s) =>
        `  • "${s.title}" — ${s.brand} | ${s.color} | ${s.category} | ${s.price_range}`
      ).join("\n") + `\nWeight these heavily. Same silhouette family, fabric weight, color temperature, brand tier.\n\n`
    : "";

  // ── Prompt ───────────────────────────────────────────────────────────────────
  // Structure: (1) internalize the board visually, (2) score each product on 4
  // specific axes against what you saw, (3) build outfits from the best matches.

  const boardSection = B > 0
    ? `IMAGES 1–${B}: THE CLIENT'S PINTEREST BOARD
Study every board image carefully before looking at any products.
Build a complete visual vocabulary across all 8 dimensions below.
Note what REPEATS — anything appearing 2+ times is a strong preference signal.
Note what is ABSENT — missing things are avoids just as much as stated ones.

  1. COLOR
     • Specific tones (not "beige" — warm oat? cool stone? dusty blush?)
     • Temperature: warm-leaning or cool-leaning overall?
     • Saturation: muted/tonal or rich/saturated?
     • Range: tight monochromatic or broader palette?
     • Metals/neutrals if present: gold or silver? warm or cool hardware?

  2. PATTERN
     • Dominant surface: solid, or patterned?
     • If patterns appear: what types? (floral, stripe, check/plaid, abstract, animal, geometric, botanical, paisley)
     • Scale of any patterns: micro/subtle or macro/bold?
     • Pattern density: sparse and airy or dense and all-over?
     • Does pattern repeat across the board, or is solid the norm with pattern as accent?

  3. SILHOUETTE & PROPORTION
     • Body relationship: body-conscious, relaxed, or oversized?
     • Length language: mini, midi, maxi — or a mix?
     • Waist: defined, dropped, or ignored?
     • Proportion play: cropped top + high-waist? long + long? structured + loose?
     • Does the board favor volume somewhere (sleeve, skirt, wide leg)?

  4. FABRIC & TEXTURE
     • Weight: sheer and light, medium-weight, or substantial and heavy?
     • Hand: fluid and drapey, crisp and structured, or textured and tactile?
     • Finish: matte (linen, cotton, suede) or sheen (satin, silk, leather, patent)?
     • Texture language: smooth, ribbed, napped, woven, knit, rough?

  5. CONSTRUCTION & DETAIL
     • Tailored/structured pieces vs unstructured/relaxed?
     • Embellishment language: minimal, subtle detail, or decorated?
     • Hardware: are zippers, buttons, buckles visible? what finish?
     • Finishing: raw hems? pressed seams? exposed stitching? polished or undone?
     • Specific recurring details (wrap ties, pleating, ruching, smocking, cut-outs, ruffles)?

  6. STYLING LOGIC
     • How are pieces layered or combined in the board images?
     • Tucked or untucked? belted or unbelted? knotted?
     • Shoe/bag energy that recurs: heeled or flat? structured or slouchy? minimal or statement?
     • Accessories: jewelry tone, scale, presence or absence?

  7. SETTING & CONTEXT
     • Where are these images shot? (studio, urban, natural, interior, editorial)
     • Lighting mood: bright and airy, moody and dim, warm golden, cool clinical?
     • Does the setting suggest a particular lifestyle or world?

  8. WHAT IS CONSPICUOUSLY ABSENT
     • Logos, branding, heavy graphics?
     • Neon or very saturated colors?
     • Particular silhouettes that simply do not appear (bodycon, oversized, etc.)?
     • Any category that appears zero times?

Hold this complete vocabulary as your scoring rubric. Every product gets scored against it.`
    : `(No board images — use the StyleDNA text as your sole reference.)`;

  const productSection = productImgBlocks.length > 0
    ? `IMAGES ${B + 1}–${B + productImgBlocks.length}: PRODUCT PHOTOS (in label order)
${labelMap.filter((e) => e.imgSlot !== null).map((e) => `  Img ${B + e.imgSlot!} = ${e.label}`).join("\n")}`
    : "";

  const promptText =
`You are a senior fashion editor. This is a WOMEN'S FASHION curation. No menswear, ever.

═══════════════════════════════════════
STEP 1 — BUILD THE BOARD'S VISUAL VOCABULARY (images 1–${B || "?"})
═══════════════════════════════════════
${boardSection}

═══════════════════════════════════════
STEP 2 — SCORE EVERY PRODUCT IMAGE
═══════════════════════════════════════
${productSection}

For each product image, check it against the board vocabulary you built:

  ✓ COLOR MATCH: Does the specific tone/warmth/saturation align with the board's color story?
  ✓ PATTERN MATCH: Does the surface language match? (solid board → solid or very subtle products; patterned board → what type/scale of pattern fits?)
  ✓ SILHOUETTE MATCH: Does this cut, length, and proportion belong in the board's world?
  ✓ FABRIC/TEXTURE MATCH: Same weight class? Same finish family (matte vs sheen)?
  ✓ DETAIL/CONSTRUCTION MATCH: Does the level of embellishment and finishing feel consistent?
  ✓ MOOD MATCH: Same energy — same level of polish, restraint, drama, or ease?

KEEP if it passes 4 of 6. REJECT if it passes 2 or fewer.
HARD REJECT: male model or clearly male-cut garment.
HARD REJECT: matches any item on the client's avoids list.
STRONG BONUS: product shares a specific element that REPEATS on the board (a recurring color, a recurring pattern type, a recurring silhouette).

═══════════════════════════════════════
STEP 3 — BUILD TWO OUTFITS
═══════════════════════════════════════
From your kept products, assemble two outfits (4 pieces each, 8 total).
Each outfit should feel like a different scene from the same person's life.
The two outfits together should express the full range of the board's vibe — not two identical looks.

CLIENT PROFILE (use this to calibrate Steps 1 and 2, not override them):
Aesthetic: ${dna.primary_aesthetic}${dna.secondary_aesthetic ? ` / ${dna.secondary_aesthetic}` : ""}
Mood: ${dna.mood}
Palette: ${dna.color_palette.join(", ")}
Silhouettes she reaches for: ${(dna.silhouettes ?? []).join(", ")}
Key pieces: ${dna.key_pieces.join(", ")}
Hard avoids: ${dna.avoids.join(", ")}
Budget: ${dna.price_range}
${dna.style_references?.length ? `Style references: ${dna.style_references.map((r) => `${r.name} (${r.era})`).join(", ")}` : ""}
${dna.summary ? `\n"${dna.summary}"` : ""}

${clickBlock}${trendsBlock ? `${trendsBlock}\n` : ""}FULL PRODUCT CATALOGUE (all categories):
${catalogueText}

OUTFIT ARC: name the relationship between the two outfits in 3–4 words (e.g. "soft / sharp", "day / night", "easy / considered").
Each outfit gets a short phrase capturing its feeling, not its occasion.

COPY RULES — apply to every sentence you write:
- No em dashes. No superlatives (perfect, stunning, effortless, elevated, iconic, impeccable).
- Write like someone who already knows — quiet confidence, specific observations, no persuasion.
- One sentence per field. Short. Dense with meaning.

ONLY use labels that exist in the catalogue. Never invent a label.

Return ONLY valid JSON:
{
  "outfit_arc": "3–4 words",
  "outfit_a_role": "short phrase for Outfit A",
  "outfit_b_role": "short phrase for Outfit B",
  "editorial_intro": "2 sentences. Quiet and specific. No em dashes.",
  "edit_rationale": "1 sentence. What visually connects these 8 pieces.",
  "selections": [
    {
      "category": "dress",
      "label": "DRESS-2",
      "outfit_group": "outfit_a",
      "outfit_role": "the anchor | the layer | the detail | the easy one | the considered one",
      "style_note": "One sentence. Reference something specific you saw in the product image.",
      "how_to_wear": "One concrete styling idea. Name another selected piece by label if it helps."
    }
  ]
}`;

  const message = await client.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2800,
    messages: [{
      role: "user",
      content: [
        ...boardImgBlocks,
        ...productImgBlocks,
        { type: "text" as const, text: promptText },
      ],
    }],
  });

  const rawText = message.content[0].type === "text" ? message.content[0].text : "";
  const json    = rawText.match(/\{[\s\S]*\}/)?.[0] ?? "{}";

  type RawResult = {
    outfit_arc:      string;
    outfit_a_role:   string;
    outfit_b_role:   string;
    editorial_intro: string;
    edit_rationale:  string;
    selections: Array<{
      category:     string;
      label:        string;
      outfit_group: OutfitGroup;
      outfit_role:  string;
      style_note:   string;
      how_to_wear:  string;
    }>;
  };

  const clean = (s: string) => (s ?? "").replace(/\s*—\s*/g, ". ").replace(/\s*–\s*/g, ", ").trim();

  let raw: RawResult;
  try {
    raw = JSON.parse(json) as RawResult;
  } catch {
    // Fallback: first product per category alternating outfits
    const fallback = categories.flatMap((cat, ci) =>
      candidates[cat].slice(0, 1).map((p) => ({
        ...p,
        style_note:   `A considered pick for your ${dna.primary_aesthetic} aesthetic.`,
        outfit_role:  "versatile staple",
        outfit_group: (ci % 2 === 0 ? "outfit_a" : "outfit_b") as OutfitGroup,
        how_to_wear:  "Style with the other pieces from your shortlist.",
      }))
    );
    return { products: fallback, editorial_intro: "", edit_rationale: "", outfit_arc: "", outfit_a_role: "", outfit_b_role: "" };
  }

  const byLabel = new Map<string, AlgoliaProduct>(labelMap.map(({ label, product }) => [label, product]));

  const products: CuratedProduct[] = (raw.selections ?? [])
    .filter((s) => byLabel.has(s.label))
    .slice(0, 8)
    .map((s) => ({
      ...byLabel.get(s.label)!,
      style_note:   clean(s.style_note),
      outfit_role:  s.outfit_role  ?? "versatile staple",
      outfit_group: s.outfit_group ?? "outfit_a",
      how_to_wear:  clean(s.how_to_wear),
    }));

  raw.editorial_intro = clean(raw.editorial_intro ?? "");
  raw.edit_rationale  = clean(raw.edit_rationale  ?? "");
  raw.outfit_arc      = clean(raw.outfit_arc      ?? "");
  raw.outfit_a_role   = clean(raw.outfit_a_role   ?? "");
  raw.outfit_b_role   = clean(raw.outfit_b_role   ?? "");

  // Fallback fill if Claude returned fewer than 8
  if (products.length < 8) {
    const usedIds      = new Set(products.map((p) => p.objectID));
    const outfitACount = products.filter((p) => p.outfit_group === "outfit_a").length;
    for (const cat of categories) {
      if (products.length >= 8) break;
      for (const extra of candidates[cat]) {
        if (products.length >= 8) break;
        if (usedIds.has(extra.objectID)) continue;
        usedIds.add(extra.objectID);
        const group: OutfitGroup = products.filter((p) => p.outfit_group === "outfit_a").length <= outfitACount ? "outfit_a" : "outfit_b";
        products.push({ ...extra, style_note: `A key piece for your ${dna.primary_aesthetic} aesthetic.`, outfit_role: "versatile staple", outfit_group: group, how_to_wear: "Style this with the other pieces from your shortlist." });
      }
    }
  }

  // Persist the keep/reject split as training data for the taste projection
  // head. Fire-and-forget — does not await, never throws. See
  // lib/curation-log.ts and scripts/train-taste-head.mjs.
  const candidateIds = labelMap.map((e) => e.product.objectID);
  const keptIds      = products.map((p) => p.objectID);
  const boardUrls    = boardImages
    .map((img) => (img as VisionImage & { url?: string })?.url)
    .filter((u): u is string => typeof u === "string" && u.startsWith("http"));
  logCuration({ dna, candidateIds, keptIds, boardImageUrls: boardUrls });

  return {
    products,
    editorial_intro: raw.editorial_intro ?? "",
    edit_rationale:  raw.edit_rationale  ?? "",
    outfit_arc:      raw.outfit_arc      ?? "",
    outfit_a_role:   raw.outfit_a_role   ?? "",
    outfit_b_role:   raw.outfit_b_role   ?? "",
  };
}

// ── Legacy alias ──────────────────────────────────────────────────────────────

export async function findProducts(dna: StyleDNA): Promise<AlgoliaProduct[]> {
  const candidates = await fetchCandidateProductsByCategory(dna);
  const filtered   = filterByAvoids(candidates, dna.avoids ?? []);
  const result     = await curateProducts(dna, filtered);
  return result.products;
}

// ── Text query → StyleDNA ─────────────────────────────────────────────────────
// Used when the user types a free-text search instead of using a Pinterest board.
// Returns the same StyleDNA shape so the rest of the pipeline is unchanged.

export async function textQueryToAesthetic(
  query:        string,
  previousDNAs: StyleDNA[] = []
): Promise<StyleDNA> {
  const client = getClient();

  // STYLE-PIVOT GUARD — when a user types a short, decisive brief like
  // "Dad-core chic" or "night at the opera" they're often pivoting away
  // from their established taste, not refining it. Feeding their previous
  // boards into Claude with the instruction "strengthen patterns that
  // repeat" actively pulls the interpretation back toward old terrain
  // and surfaces feminine dresses for menswear briefs (and vice versa).
  // Heuristic: queries ≤6 words are deliberate aesthetic pivots → no
  // history. Longer queries are usually descriptive / refining →
  // history is helpful.
  const wordCount = query.trim().split(/\s+/).filter(Boolean).length;
  const isShortPivot = wordCount > 0 && wordCount <= 6;
  const useHistory = previousDNAs.length > 0 && !isShortPivot;
  const historyBlock = useHistory ? buildHistoryBlock(previousDNAs) : "";

  const promptText =
    `You are a fashion editor and stylist with a sharp, quiet eye.\n` +
    (useHistory ? `\n${historyBlock}\n\n` : "") +
    `A user is looking for fashion recommendations and described their style or intent in their own words:\n\n` +
    `"${query}"\n\n` +
    `Interpret this as a fashion brief. Infer aesthetic, palette, silhouettes, mood, and shopping intent from their words. ` +
    `Be generous — they may be vague or use non-fashion language. ` +
    `If they mention an occasion (dinner, vacation, work), let that shape the occasion_mix. ` +
    `If they mention price signals ("affordable", "investment piece", "splurge"), set price_range accordingly. ` +
    `Read the brief on its own terms — if it's masculine-coded ("dad-core", "menswear", "workwear"), use empty arrays for dress and lean masculine across other categories; if it's coded for one occasion or category, set focus_categories. Don't pad categories that don't fit just to fill the schema.\n\n` +
    `Return a StyleDNA JSON. Be specific and exact — no filler, no em dashes, no superlatives. Return ONLY valid JSON:\n\n` +
    JSON_SCHEMA_TEMPLATE;

  const message = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 1800,
    messages:   [{ role: "user", content: promptText }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  return JSON.parse(json) as StyleDNA;
}

// ── Questionnaire answers → StyleDNA ─────────────────────────────────────────
// Converts a structured style quiz response into a StyleDNA.

export async function questionnaireToAesthetic(
  answers:      QuestionnaireAnswers,
  previousDNAs: StyleDNA[] = []
): Promise<StyleDNA> {
  const client = getClient();
  const historyBlock = buildHistoryBlock(previousDNAs);

  const brief = [
    answers.occasions.length  ? `Occasions: ${answers.occasions.join(", ")}`          : null,
    answers.vibes.length      ? `Aesthetic vibes: ${answers.vibes.join(", ")}`        : null,
    answers.colors.length     ? `Color direction: ${answers.colors.join(", ")}`       : null,
    answers.fits.length       ? `Fit preference: ${answers.fits.join(", ")}`          : null,
    `Budget: ${answers.priceRange}`,
  ].filter(Boolean).join("\n");

  const promptText =
    `You are a fashion editor and stylist with a sharp, quiet eye.\n` +
    (previousDNAs.length > 0 ? `\n${historyBlock}\n\n` : "") +
    `A user completed a style quiz with these answers:\n\n${brief}\n\n` +
    `Synthesise these into a precise StyleDNA. Use the vibe labels as starting points but make the result specific and nuanced — ` +
    `don't just echo the input labels back. A "clean girl + coastal" person is different from "clean girl + old money". ` +
    `Color direction should translate into specific palette colors (not just "neutrals" — be precise: warm ivory, stone, etc.).\n\n` +
    `Return ONLY valid JSON:\n\n` +
    JSON_SCHEMA_TEMPLATE;

  const message = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 1800,
    messages:   [{ role: "user", content: promptText }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  const dna  = JSON.parse(json) as StyleDNA;

  // Honour the explicit price range from the quiz — don't let Claude override it
  dna.price_range = answers.priceRange;
  return dna;
}

// ── Comment refinement → updated StyleDNA ────────────────────────────────────
// Used by /api/refine to tweak the aesthetic based on a user's "say more" comment.

export async function refineAesthetic(
  currentDNA: StyleDNA,
  comment:    string
): Promise<StyleDNA> {
  const client = getClient();

  const promptText =
    `You are a fashion editor refining a style profile based on user feedback.\n\n` +
    `Current style profile:\n${JSON.stringify(currentDNA, null, 2)}\n\n` +
    `User feedback: "${comment}"\n\n` +
    `Make targeted changes to the profile based on this feedback. The feedback might:\n` +
    `- Request a different vibe ("more minimalist", "less formal", "edgier")\n` +
    `- Adjust categories ("more bags", "fewer dresses")\n` +
    `- Shift colors ("more earth tones", "no florals", "more black")\n` +
    `- Change fit ("more flowy", "less fitted")\n\n` +
    `Only change what the feedback explicitly or clearly implies. Return the full updated StyleDNA JSON. Return ONLY valid JSON.`;

  const message = await client.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2000,
    messages:   [{ role: "user", content: promptText }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return currentDNA;

  try {
    return { ...currentDNA, ...JSON.parse(json) as StyleDNA };
  } catch {
    return currentDNA;
  }
}

// ── Comment-driven session refinement (single Claude vision call) ────────────
//
// When a user comments ("more romantic, less structured"), this single call
// does three things at once:
//   1. Refines the StyleDNA aggressively — adds to `avoids`, strengthens
//      whichever field the comment targets. Not timid.
//   2. Looks at the upcoming product queue and returns indices of items
//      that still fit the refined direction (the rest get wiped).
//   3. Returns a one-sentence interpretation of the intent — useful for UI.

interface SessionRefinement {
  refinedDNA: StyleDNA;
  intent:     string;
  keepIds:    string[];
}

const MAX_UPCOMING_TO_INSPECT = 16;

export async function refineSessionWithComment(
  currentDNA: StyleDNA,
  comment:    string,
  upcomingProducts: Array<{
    objectID: string;
    title?:    string;
    brand?:    string;
    image_url?: string;
  }> = [],
): Promise<SessionRefinement> {
  if (!comment.trim()) {
    return { refinedDNA: currentDNA, intent: "", keepIds: upcomingProducts.map((p) => p.objectID) };
  }

  // Filter to items with usable image URLs and cap for cost
  const usable = upcomingProducts
    .filter((p) => typeof p.image_url === "string" && p.image_url.startsWith("http"))
    .slice(0, MAX_UPCOMING_TO_INSPECT);

  const itemList = usable
    .map((p, i) => `${i + 1}. ${p.brand ?? ""} — ${p.title ?? ""}`)
    .join("\n");

  const upcomingBlock = usable.length > 0
    ? `The next ${usable.length} items they are about to see (images in the same order, numbered 1-${usable.length}):\n${itemList}\n\n`
    : "";

  const promptText =
    `You are a fashion editor refining a user's session in real time based on their feedback.\n\n` +
    `Their current style profile:\n${JSON.stringify(currentDNA, null, 2)}\n\n` +
    `Feedback they just gave: "${comment}"\n\n` +
    upcomingBlock +
    `Do three things and return as a single JSON object:\n\n` +
    `1. **Refine the StyleDNA aggressively.** Be decisive — don't be timid:\n` +
    `   - "less X" / "no more X" → ADD that pattern to "avoids"\n` +
    `   - "more Y" → strengthen color_palette / silhouettes / style_keywords / mood toward Y\n` +
    `   - Mood/aesthetic shifts should rewrite primary_aesthetic and mood, not just append\n` +
    `   - Always rebuild category_queries to reflect the new direction\n` +
    `   Return the COMPLETE updated StyleDNA (all fields, including unchanged ones).\n\n` +
    `2. **Interpret the intent in one short sentence** ("you want more bold florals", "you want to drop anything tailored").\n\n` +
    (usable.length > 0
      ? `3. **Pick which numbered upcoming items still fit the refined direction.** Be strict — anything that does not match the new vibe should be dropped. Return the indices that should stay.\n\n`
      : `3. (No upcoming items provided — return [] for keepIndices.)\n\n`) +
    `Return ONLY valid JSON in this shape:\n` +
    `{\n` +
    `  "refinedDNA": { ...complete StyleDNA... },\n` +
    `  "intent": "one short sentence",\n` +
    `  "keepIndices": [array of numbers]\n` +
    `}`;

  // Vision blocks for upcoming items (mirrors curateProducts pattern)
  const imgBlocks: Array<{ type: "image"; source: { type: "url"; url: string } }> = usable.map((p) => ({
    type:   "image" as const,
    source: { type: "url" as const, url: sizeImageUrl(p.image_url!) },
  }));

  const userContent: Anthropic.MessageParam["content"] = [
    ...imgBlocks,
    { type: "text" as const, text: promptText },
  ];

  try {
    const client  = getClient();
    const message = await client.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 3000,
      messages:   [{ role: "user", content: userContent }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error("no JSON in response");

    const parsed = JSON.parse(json) as {
      refinedDNA?:   Partial<StyleDNA>;
      intent?:       string;
      keepIndices?:  number[];
    };

    // Map keep indices back to objectIDs (1-indexed in prompt)
    const keepIds = (parsed.keepIndices ?? [])
      .map((i) => usable[i - 1]?.objectID)
      .filter((id): id is string => id != null);

    return {
      refinedDNA: { ...currentDNA, ...(parsed.refinedDNA ?? {}) } as StyleDNA,
      intent:     parsed.intent ?? comment,
      keepIds,
    };
  } catch (err) {
    console.warn("[refineSessionWithComment] fell back to bare refineAesthetic:", err instanceof Error ? err.message : err);
    // Fallback to the simpler refine path so a vision-call failure
    // doesn't leave the user stranded with no refinement at all.
    const fallbackDNA = await refineAesthetic(currentDNA, comment).catch(() => currentDNA);
    return { refinedDNA: fallbackDNA, intent: comment, keepIds: usable.map((p) => p.objectID) };
  }
}

// ── Claude vision re-rank ────────────────────────────────────────────────────
//
// FashionCLIP gets you in the right neighborhood; Claude vision picks the
// pieces that *actually* fit the vibe. We pass the top N FashionCLIP
// candidates per category to Claude with image URLs and the StyleDNA, and
// it returns a re-ordered objectID list. Plug in after hybridSearch.
//
// Cost note: roughly 1 Claude vision call per category per "build my edit"
// click. Keep MAX_CANDIDATES_PER_CATEGORY tight (≤24) to bound cost.

const MAX_CANDIDATES_TO_RERANK = 24; // hard cap per category — cost control
const RERANK_CATEGORIES = ["dress", "top", "bottom", "jacket", "shoes", "bag"] as const;

interface RerankableCandidate {
  objectID:   string;
  title:      string;
  brand?:     string;
  image_url?: string;
  price?:     number | null;
}

/**
 * Re-rank one category's FashionCLIP candidates by visual+semantic fit.
 * Uses Claude vision to look at each image and choose the best matches
 * for the StyleDNA. Returns objectIDs in the new order; falls back to
 * the original order if Claude fails or returns invalid JSON.
 */
async function rerankCategory(
  category:    string,
  candidates:  RerankableCandidate[],
  dna:         StyleDNA,
  topK:        number,
): Promise<string[]> {
  // Cap and filter to candidates with image URLs
  const usable = candidates
    .filter((c) => c.image_url && c.image_url.startsWith("http"))
    .slice(0, MAX_CANDIDATES_TO_RERANK);

  if (usable.length === 0) return candidates.map((c) => c.objectID);
  if (usable.length <= topK) return usable.map((c) => c.objectID);

  // Build numbered list so Claude can refer to items by index
  const itemList = usable
    .map((c, i) => `${i + 1}. ${c.brand ?? ""} — ${c.title}${c.price ? ` ($${Math.round(c.price)})` : ""}`)
    .join("\n");

  const promptText =
    `You are a fashion editor curating a ${category} edit for someone with this style profile:\n\n` +
    `${JSON.stringify({
      primary_aesthetic:   dna.primary_aesthetic,
      secondary_aesthetic: dna.secondary_aesthetic,
      mood:                dna.mood,
      color_palette:       dna.color_palette,
      silhouettes:         dna.silhouettes,
      style_keywords:      dna.style_keywords,
      avoids:              dna.avoids,
    }, null, 2)}\n\n` +
    `Below are ${usable.length} candidate ${category} pieces. The images are in the same order as the numbered list:\n\n` +
    `${itemList}\n\n` +
    `Pick the top ${topK} that best match the aesthetic. Consider:\n` +
    `- Visual fit with the color palette and silhouettes\n` +
    `- Whether it embodies the mood (avoid pieces that feel off-vibe)\n` +
    `- Variety — don't pick 5 near-identical items\n` +
    `- Avoids — skip anything matching the avoid list\n\n` +
    `Return ONLY a JSON array of the chosen indices in your preferred order, e.g. [3, 7, 1, 12, 9, 4, 18, 2, 11, 6, 14, 8]. No other text.`;

  // Build vision content blocks — image URL references for each candidate.
  // Pattern matches the existing one used elsewhere in this file (curateProducts).
  const imgBlocks: Array<{ type: "image"; source: { type: "url"; url: string } }> = [];
  for (const c of usable) {
    imgBlocks.push({
      type:   "image" as const,
      source: { type: "url" as const, url: sizeImageUrl(c.image_url!) },
    });
  }
  const userContent: Anthropic.MessageParam["content"] = [
    ...imgBlocks,
    { type: "text" as const, text: promptText },
  ];

  try {
    const client  = getClient();
    const message = await client.messages.create({
      model:      "claude-haiku-4-5", // small/fast model — re-rank is constrained, low-stakes
      max_tokens: 200,
      messages:   [{ role: "user", content: userContent }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const arr  = text.match(/\[[\s\S]*?\]/)?.[0];
    if (!arr) throw new Error("no JSON array in response");

    const indices = JSON.parse(arr) as number[];
    const reordered: string[] = [];
    const seen = new Set<number>();
    for (const i of indices) {
      const idx = i - 1;
      if (idx >= 0 && idx < usable.length && !seen.has(idx)) {
        reordered.push(usable[idx].objectID);
        seen.add(idx);
      }
      if (reordered.length >= topK) break;
    }

    // Pad with anything Claude omitted (preserves original FashionCLIP order)
    for (let i = 0; i < usable.length && reordered.length < topK; i++) {
      if (!seen.has(i)) reordered.push(usable[i].objectID);
    }
    return reordered;
  } catch (err) {
    console.warn(`[rerank] ${category} fell back to FashionCLIP order:`, err instanceof Error ? err.message : err);
    return usable.slice(0, topK).map((c) => c.objectID);
  }
}

/**
 * Re-rank a CategoryCandidates bucket using Claude vision.
 * Runs categories in parallel. Returns a new CategoryCandidates with each
 * bucket reordered (and trimmed to topK). Buckets with ≤ topK items pass
 * through unchanged — no point spending Claude tokens on a 5-item set.
 *
 * Pass `topK = 12` to take the curated 12 per category Claude considers best.
 */
export async function rerankCandidatesByVision(
  buckets: CategoryCandidates,
  dna:     StyleDNA,
  topK     = 12,
): Promise<CategoryCandidates> {
  const result: CategoryCandidates = {
    dress: [], top: [], bottom: [], jacket: [], shoes: [], bag: [],
  };

  await Promise.all(
    RERANK_CATEGORIES.map(async (cat) => {
      const items = buckets[cat] ?? [];
      if (items.length === 0) { result[cat] = items; return; }
      if (items.length <= topK) { result[cat] = items; return; }

      const lookup = new Map(items.map((it) => [it.objectID, it]));
      const orderedIds = await rerankCategory(cat, items, dna, topK);
      result[cat] = orderedIds
        .map((id) => lookup.get(id))
        .filter((it): it is AlgoliaProduct => it != null);
    }),
  );

  return result;
}
