import Anthropic from "@anthropic-ai/sdk";
import {
  searchByCategory,
  searchByMultipleQueries,
  searchProducts,
  type AlgoliaProduct,
  type CategoryCandidates,
  type ClothingCategory,
} from "@/lib/algolia";
import type { StyleDNA, ClickSignal, VisionImage } from "@/lib/types";

// Re-export so consumers can import from either place
export type {
  StyleDNA,
  StyleReference,
  CategoryQueries,
  ClickSignal,
  VisionImage,
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
  boardName:    string,
  pinDescriptions: string[],
  images:       VisionImage[] = [],
  previousDNAs: StyleDNA[]   = []
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

  const message = await client.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2500,
    messages: [
      {
        role: "user",
        content: [
          ...toImageBlocks(images),
          { type: "text" as const, text: promptText },
        ],
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

// ── Step 3a: Visual shortlist (48 → 12) ──────────────────────────────────────
// Board images ARE the reference. Claude asks: "could this product appear on that board?"

async function shortlistCandidates(
  dna:         StyleDNA,
  candidates:  CategoryCandidates,
  client:      Anthropic,
  boardImages: VisionImage[] = []
): Promise<CategoryCandidates> {
  const categories: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];

  const categoryBlocks = categories.map((cat) => {
    const pool = candidates[cat];
    if (pool.length === 0) return `${cat.toUpperCase()}: (no products — skip this category)`;
    const items = pool.map((p, i) => ({
      idx:         i,
      title:       p.title,
      brand:       p.brand,
      tags:        (p.aesthetic_tags ?? []).slice(0, 6).join(", "),
      description: (p.description || "").slice(0, 100),
      price_range: p.price_range,
      retailer:    p.retailer,
    }));
    return `${cat.toUpperCase()} (${pool.length} options):\n${JSON.stringify(items, null, 1)}`;
  }).join("\n\n");

  const hasBoardImages = boardImages.length > 0;

  const promptText =
    `You are a senior fashion editor doing a first-pass curation.` +
    (hasBoardImages
      ? ` The ${boardImages.length} images above are the client's Pinterest board — use them as mood/vibe reference, not as a strict palette checklist.`
      : "") +
    `\n\nYour job: pick the 6-8 BEST products from the candidates below that could work for this client.

CLIENT:
Aesthetic: ${dna.primary_aesthetic}${dna.secondary_aesthetic ? ` — ${dna.secondary_aesthetic}` : ""}
References: ${(dna.style_references ?? []).map((r) => `${r.name} (${r.era})`).join(", ") || "none"}
Palette: ${dna.color_palette.join(", ")}
Key pieces: ${dna.key_pieces.join(", ")}
Hard avoids: ${dna.avoids.join(", ")}

CANDIDATES (skip any category marked "no products"):
${categoryBlocks}

TASK: Pick the 6-8 products that feel most true to this client's world.
- Be GENEROUS with interpretation — different pieces can express different facets of the same aesthetic (e.g., romantic vs. edgy, classic vs. maximalist)
- Only hard-eliminate things that hit the avoids list or are completely tonally wrong
- If a category has products, pick at least 1 (up to 3 from dress/top since those dominate the catalogue)
- Do NOT worry about strict palette matching — vibe matters more than exact color

Return ONLY this JSON:
{
  "shortlist": [
    { "category": "dress",  "idx": 0 },
    { "category": "dress",  "idx": 2 }
  ]
}`;

  const message = await client.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 800,
    messages: [
      {
        role: "user",
        content: [
          ...toImageBlocks(boardImages, 8),
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
    if (product && finalists[cat].length < 5) finalists[cat].push(product); // allow up to 5 per category
  }

  // Guarantee at least 2 picks per available category (to give Stage 2 real choice)
  for (const cat of categories) {
    if (finalists[cat].length === 0 && candidates[cat].length > 0) {
      finalists[cat].push(...candidates[cat].slice(0, 3));
    } else if (finalists[cat].length === 1 && candidates[cat].length > 1) {
      const next = candidates[cat].find((p) => p.objectID !== finalists[cat][0].objectID);
      if (next) finalists[cat].push(next);
    }
  }

  return finalists;
}

// ── Step 3b: Outfit build with vision + narrative arc + click history ─────────

async function buildOutfitsWithVision(
  dna:          StyleDNA,
  finalists:    CategoryCandidates,
  client:       Anthropic,
  clickSignals: ClickSignal[] = [],
  trendsBlock:  string = ""
): Promise<CurationResult> {
  const categories: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];

  const labelMap: Array<{ label: string; product: AlgoliaProduct }> = [];
  for (const cat of categories) {
    finalists[cat].forEach((product, si) => {
      labelMap.push({ label: `${cat.toUpperCase()}-${si === 0 ? "A" : "B"}`, product });
    });
  }

  const imageEntries = labelMap.filter((e) => e.product.image_url?.startsWith("http"));

  const imageBlocks = imageEntries.map((e) => ({
    type:   "image" as const,
    source: { type: "url" as const, url: e.product.image_url },
  }));

  const imageKeyText = imageEntries.length > 0
    ? `PRODUCT IMAGES (above, in this order):\n${imageEntries.map((e, i) =>
        `  Image ${i + 1} → ${e.label}: "${e.product.title}" by ${e.product.brand}`).join("\n")}`
    : "(No product images — rely on text descriptions only.)";

  const catalogueText = categories.map((cat) => {
    const pool = finalists[cat];
    if (pool.length === 0) return null; // skip empty categories
    return pool.map((p, si) => {
      const label = `${cat.toUpperCase()}-${si === 0 ? "A" : "B"}`;
      return `  ${label}: "${p.title}" — ${p.brand} | colour: ${p.color || "unspecified"} | material: ${(p.material || "unknown").slice(0, 60)} | ${p.price_range} | ${p.retailer}`;
    }).join("\n");
  }).filter(Boolean).join("\n\n");

  // Click history block — confirmed positive taste signals
  const clickBlock = clickSignals.length > 0
    ? `\nCONFIRMED TASTE SIGNALS — products this person has previously clicked through to:\n` +
      clickSignals.slice(0, 10).map((s) =>
        `  • "${s.title}" — ${s.brand} | ${s.color} | ${s.category} | ${s.price_range}`
      ).join("\n") +
      `\n\nThese are not aspirational — they are proven taste. Bias your selections toward similar choices: ` +
      `same fabric weight, brand tier, color story, silhouette. If a finalist closely matches a clicked product, prefer it.\n`
    : "";

  const promptText = `You are a fashion editor making the final call on a curated edit. You can see the product images above. Trust what you see.

VOICE RULES — apply to every piece of text you write:
- No em dashes. Use a period or rewrite the sentence instead.
- No superlatives: not "perfect", "stunning", "elevated", "effortless", "impeccable", "iconic".
- No hype language: not "statement piece" as a cliche, not "takes it to the next level", not "the epitome of".
- Write like someone who already knows — quiet confidence, not persuasion.
- Short sentences. Specific observations. No filler.

CLIENT PROFILE:
Aesthetic: ${dna.primary_aesthetic}${dna.secondary_aesthetic ? `, ${dna.secondary_aesthetic}` : ""}
Mood: ${dna.mood}
Palette: ${dna.color_palette.join(", ")}
Silhouettes: ${(dna.silhouettes ?? []).join(", ")}
Reaches for: ${dna.key_pieces.join(", ")}
Hard avoids: ${dna.avoids.join(", ")}
Budget: ${dna.price_range}
Style summary: ${dna.summary}
${dna.style_references?.length ? `References: ${dna.style_references.map((r) => `${r.name} (${r.era})`).join(", ")}` : ""}
${clickBlock}${trendsBlock ? `\n${trendsBlock}\n` : ""}
${imageKeyText}

FINALISTS BY CATEGORY:
${catalogueText}

YOUR TASK:
1. Look at the images. Pick by feel, not just palette.
2. Select 3 products for Outfit A and 3 for Outfit B (6 total). You can use two dresses across different outfits if that's what works.
3. Each outfit should represent a different side of this client's taste.

OUTFIT ARC:
The two outfits should have a natural relationship. Name it plainly: "day / night", "soft / sharp", "easy / considered", etc. Keep it to 3-4 words. Give each outfit a short phrase that captures its feeling, not its occasion.

Rules:
- ONLY select labels that exist in the FINALISTS list. Never invent labels.
- Each outfit needs 3 pieces.
- Hard eliminate anything that hits the avoids list.
- how_to_wear: one specific, practical styling idea. Reference another selected product by its full title if it makes sense.

Return ONLY valid JSON:
{
  "outfit_arc": "3-4 words, e.g. 'soft / sharp'",
  "outfit_a_role": "a short phrase for Outfit A, e.g. 'something to wear slowly'",
  "outfit_b_role": "a short phrase for Outfit B, e.g. 'when you want to be looked at'",
  "editorial_intro": "2 sentences. Quiet, specific, no hype. No em dashes. Describe what this edit is actually for.",
  "edit_rationale": "1 sentence. Plain language. What connects these pieces.",
  "selections": [
    {
      "category": "dress",
      "label": "DRESS-A",
      "outfit_group": "outfit_a",
      "outfit_role": "the anchor | the layer | the detail | the easy one | the considered one",
      "style_note": "One sentence. Specific to this piece and this person. No em dashes, no superlatives.",
      "how_to_wear": "One practical styling idea. Specific, not generic."
    }
  ]
}`;

  const message = await client.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2500,
    messages: [
      {
        role: "user",
        content: [
          ...imageBlocks,
          { type: "text" as const, text: promptText },
        ],
      },
    ],
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

  let raw: RawResult;
  try {
    raw = JSON.parse(json) as RawResult;
  } catch {
    const fallback = categories.flatMap((cat, ci) =>
      finalists[cat].slice(0, 1).map((p) => ({
        ...p,
        style_note:   `A considered pick for your ${dna.primary_aesthetic} aesthetic.`,
        outfit_role:  "versatile staple",
        outfit_group: (ci % 2 === 0 ? "outfit_a" : "outfit_b") as OutfitGroup,
        how_to_wear:  "Style with other pieces from your edit.",
      }))
    );
    return { products: fallback, editorial_intro: "", edit_rationale: "", outfit_arc: "", outfit_a_role: "", outfit_b_role: "" };
  }

  const byLabel = new Map<string, AlgoliaProduct>(
    labelMap.map(({ label, product }) => [label, product])
  );

  // Strip em dashes from all text fields — belt-and-suspenders on top of the prompt rule
  const clean = (s: string) => (s ?? "").replace(/\s*—\s*/g, ". ").replace(/\s*–\s*/g, ", ").trim();

  const products: CuratedProduct[] = (raw.selections ?? [])
    .filter((s) => byLabel.has(s.label))
    .slice(0, 6)
    .map((s) => ({
      ...byLabel.get(s.label)!,
      style_note:   clean(s.style_note),
      outfit_role:  s.outfit_role  ?? "versatile staple",
      outfit_group: s.outfit_group ?? "outfit_a",
      how_to_wear:  clean(s.how_to_wear),
    }));

  // Also clean top-level narrative fields
  raw.editorial_intro = clean(raw.editorial_intro ?? "");
  raw.edit_rationale  = clean(raw.edit_rationale  ?? "");
  raw.outfit_arc      = clean(raw.outfit_arc      ?? "");
  raw.outfit_a_role   = clean(raw.outfit_a_role   ?? "");
  raw.outfit_b_role   = clean(raw.outfit_b_role   ?? "");

  if (products.length < 6) {
    const usedIds = new Set(products.map((p) => p.objectID));
    const outfitACount = products.filter((p) => p.outfit_group === "outfit_a").length;
    // Fill remaining slots, alternating outfit groups
    for (const cat of categories) {
      if (products.length >= 6) break;
      for (const extra of finalists[cat]) {
        if (products.length >= 6) break;
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

// ── Step 3: Curate — orchestrates Stage 1 + Stage 2 ─────────────────────────

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

  // Stage 1: visual shortlist — board images ground the elimination pass (48 → 12)
  const finalists = await shortlistCandidates(dna, candidates, client, boardImages);

  // Stage 2: outfit build with product images + click history + narrative arc + trends
  return buildOutfitsWithVision(dna, finalists, client, clickSignals, trendsBlock);
}

// ── Legacy alias ──────────────────────────────────────────────────────────────

export async function findProducts(dna: StyleDNA): Promise<AlgoliaProduct[]> {
  const candidates = await fetchCandidateProductsByCategory(dna);
  const filtered   = filterByAvoids(candidates, dna.avoids ?? []);
  const result     = await curateProducts(dna, filtered);
  return result.products;
}
