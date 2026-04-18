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

// Re-export so consumers can import from either place
export type {
  StyleDNA,
  StyleReference,
  CategoryQueries,
  ClickSignal,
  VisionImage,
  QuestionnaireAnswers,
} from "@/lib/types";

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
  "primary_aesthetic": "specific named aesthetic, e.g. 'quiet luxury minimalist', 'coastal grandmother', 'dark academia', 'clean girl', 'old money prep'",
  "secondary_aesthetic": "secondary influence, e.g. 'with Parisian casual undertones'",
  "color_palette": ["5-6 very specific color names — e.g. 'warm ivory', 'dusty sage', 'caramel', 'slate blue' — never just 'beige' or 'blue'"],
  "silhouettes": ["4-5 silhouette preferences, e.g. 'relaxed wide-leg trouser', 'flowy bias-cut midi', 'oversized boxy top'"],
  "key_pieces": ["5-6 specific hero garments, e.g. 'linen wrap dress', 'structured leather blazer', 'bias-cut slip skirt'"],
  "avoids": ["3-4 explicit avoids, e.g. 'heavy logos', 'neon colors', 'shiny polyester'"],
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
    "IMPORTANT": "Queries must match how products are actually titled in a retail catalogue. Short. Simple. Color + type. NOT descriptive sentences.",
    "dress": ["3 queries, MAX 3 words each — color + silhouette only — e.g. 'black midi dress', 'ivory slip dress', 'floral mini dress' — NOT 'dusty sage bias-cut linen slip dress'"],
    "top": ["3 queries, MAX 3 words each — e.g. 'cream knit top', 'white blouse', 'black bodysuit' — NOT 'relaxed oversized cotton turtleneck'"],
    "bottom": ["3 queries, MAX 3 words each — e.g. 'camel wide pants', 'black mini skirt', 'beige trousers' — NOT 'high-waisted flowy linen wide-leg trouser'"],
    "jacket": ["3 queries, MAX 3 words each — e.g. 'camel coat', 'black blazer', 'leather jacket' — NOT 'structured oversized vintage-inspired blazer'"],
    "shoes": ["3 queries, MAX 3 words each — e.g. 'black heels', 'tan sandals', 'white sneakers'"],
    "bag": ["3 queries, MAX 3 words each — e.g. 'black leather bag', 'tan tote', 'mini shoulder bag'"]
  }
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

export async function analyzeAesthetic(
  boardName:       string,
  pinDescriptions: string[],
  images:          VisionImage[] = [],
  previousDNAs:    StyleDNA[]   = [],
  extraContext?:   string
): Promise<StyleDNA> {
  const client = getClient();

  const pinText = pinDescriptions
    .slice(0, 40)
    .map((d, i) => `${i + 1}. ${d}`)
    .join("\n");

  const hasImages  = images.length > 0;
  const hasHistory = previousDNAs.length > 0;
  const historyBlock = buildHistoryBlock(previousDNAs);

  const promptText = hasImages
    ? `You are a fashion editor and stylist with a sharp, quiet eye. You identify aesthetics with precision, not hype.
${hasHistory ? `\n${historyBlock}\n` : ""}
Analyze these ${images.length} images from a Pinterest board called "${boardName}". The images are the primary source.${pinText ? `\n\nAdditional context:\n${pinText}` : ""}

Look for:
- Colors, textures, fabrics that repeat
- Silhouettes and proportions
- Mood and atmosphere
- Specific garments or styling choices that appear more than once
- The underlying aesthetic subculture
${hasHistory ? "- How does this relate to or differ from the taste history above?" : ""}

Return a StyleDNA JSON. Be specific and exact — no filler, no em dashes, no superlatives. Return ONLY valid JSON:

${JSON_SCHEMA_TEMPLATE}`
    : `You are a fashion editor and stylist with a sharp, quiet eye. You identify aesthetics with precision, not hype.
${hasHistory ? `\n${historyBlock}\n` : ""}
Analyze this Pinterest board called "${boardName}":

${pinText}

Return a StyleDNA JSON. Be specific and exact — no filler, no em dashes, no superlatives. Return ONLY valid JSON:

${JSON_SCHEMA_TEMPLATE}`;

  const userContent: Anthropic.MessageParam["content"] = [
    ...toImageBlocks(images),
    { type: "text" as const, text: promptText },
  ];

  if (extraContext) {
    userContent.push({
      type: "text",
      text: `\nAdditional context the user provided:\n${extraContext}`,
    });
  }

  const message = await client.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2500,
    messages: [
      {
        role:    "user",
        content: userContent,
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  return JSON.parse(json) as StyleDNA;
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
  const baseColors = (dna.color_palette ?? [])
    .slice(0, 4)
    .map((c) => c.toLowerCase().split(" ").pop() ?? c)   // "dusty sage" → "sage"
    .filter((c) => c.length > 2 && !/^\d/.test(c));

  const augmented: Record<ClothingCategory, string[]> = {
    dress:  [...(queries.dress  ?? []), ...baseColors.map((c) => `${c} dress`)],
    top:    [...(queries.top    ?? []), ...baseColors.map((c) => `${c} top`)],
    bottom: [...(queries.bottom ?? []), ...baseColors.map((c) => `${c} skirt`),  ...baseColors.map((c) => `${c} pants`)],
    jacket: [...(queries.jacket ?? []), ...baseColors.map((c) => `${c} blazer`), ...baseColors.map((c) => `${c} coat`)],
    shoes:  [...(queries.shoes  ?? []), ...baseColors.map((c) => `${c} heels`),  ...baseColors.map((c) => `${c} boots`)],
    bag:    [...(queries.bag    ?? []), ...baseColors.map((c) => `${c} bag`)],
  };

  const result = await searchByCategory(
    augmented,
    dna.style_keywords,
    dna.price_range,
    20,           // up from 12 — more candidates → better shortlist picks
    userToken
  );

  // Emergency guarantee: if we have very few products with images across all categories,
  // supplement with simple palette-color searches that reliably match the available inventory.
  // Hello Molly (our best-image retailer) titles look like "Flirt Hour Mini Dress Red" —
  // so "red dress", "black dress", "midi dress" always work; aesthetic keywords don't.
  const cats: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];
  const total = cats.reduce((s, c) => s + result[c].length, 0);

  if (total < 6) {
    const existingIds = new Set(cats.flatMap((c) => result[c].map((p) => p.objectID)));

    // Extract simple base colors from the palette (last word: "red", "black", "ivory")
    const baseColors = (dna.color_palette ?? [])
      .slice(0, 4)
      .map((c) => c.toLowerCase().split(" ").pop() ?? c)
      .filter((c) => c.length > 2);

    // Also add silhouette keywords as fallback queries
    const silhouetteWords = (dna.silhouettes ?? [])
      .slice(0, 2)
      .map((s) => s.toLowerCase().split(" ").pop() ?? s);

    const fallbackQueries = [
      ...baseColors.map((c) => `${c} dress`),
      ...silhouetteWords.map((s) => `${s} dress`),
      "midi dress",
      "mini dress",
    ];

    for (const q of fallbackQueries) {
      if (result.dress.length >= 8) break;
      const extras = await searchProducts(q, [], dna.price_range, 6, undefined, userToken).catch(() => [] as AlgoliaProduct[]);
      for (const p of extras) {
        if (!existingIds.has(p.objectID)) {
          existingIds.add(p.objectID);
          result.dress.push(p);
        }
      }
    }
  }

  return result;
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
        productImgBlocks.push({ type: "image" as const, source: { type: "url" as const, url: p.image_url } });
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
  // Cap at 100 product images (well within 200K context at ~1K tokens/image).
  // Products without images are still listed as text so Claude knows they exist.

  type Entry = { label: string; product: AlgoliaProduct; imgSlot: number | null };
  const labelMap: Entry[] = [];
  const productImgBlocks: Array<{ type: "image"; source: { type: "url"; url: string } }> = [];

  for (const cat of categories) {
    candidates[cat].forEach((product, idx) => {
      const hasImg = product.image_url?.startsWith("http") && productImgBlocks.length < 100;
      const label  = `${cat.toUpperCase()}-${idx}`;
      if (hasImg) {
        productImgBlocks.push({ type: "image" as const, source: { type: "url" as const, url: product.image_url } });
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
        how_to_wear:  "Style with the other pieces from your edit.",
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
        products.push({ ...extra, style_note: `A key piece for your ${dna.primary_aesthetic} aesthetic.`, outfit_role: "versatile staple", outfit_group: group, how_to_wear: "Style this with the other pieces from your edit." });
      }
    }
  }

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
  const historyBlock = buildHistoryBlock(previousDNAs);

  const promptText =
    `You are a fashion editor and stylist with a sharp, quiet eye.\n` +
    (previousDNAs.length > 0 ? `\n${historyBlock}\n\n` : "") +
    `A user is looking for fashion recommendations and described their style or intent in their own words:\n\n` +
    `"${query}"\n\n` +
    `Interpret this as a fashion brief. Infer aesthetic, palette, silhouettes, mood, and shopping intent from their words. ` +
    `Be generous — they may be vague or use non-fashion language. ` +
    `If they mention an occasion (dinner, vacation, work), let that shape the occasion_mix. ` +
    `If they mention price signals ("affordable", "investment piece", "splurge"), set price_range accordingly.\n\n` +
    `Return a StyleDNA JSON. Be specific and exact — no filler, no em dashes, no superlatives. Return ONLY valid JSON:\n\n` +
    JSON_SCHEMA_TEMPLATE;

  const message = await client.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2000,
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
    model:      "claude-sonnet-4-6",
    max_tokens: 2000,
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
    source: { type: "url" as const, url: p.image_url! },
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
      source: { type: "url" as const, url: c.image_url! },
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
