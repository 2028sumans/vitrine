import Anthropic from "@anthropic-ai/sdk";
import {
  searchByCategory,
  searchByMultipleQueries,
  type AlgoliaProduct,
  type CategoryCandidates,
  type ClothingCategory,
} from "@/lib/algolia";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StyleReference {
  name: string;  // e.g. "Carolyn Bessette-Kennedy"
  era:  string;  // e.g. "late-90s New York minimalism"
  why:  string;  // one sentence specific to this board
}

export interface CategoryQueries {
  dress:  string[];
  top:    string[];
  bottom: string[];
  jacket: string[];
  shoes:  string[];
  bag:    string[];
}

export interface StyleDNA {
  primary_aesthetic:   string;
  secondary_aesthetic: string;
  color_palette:       string[];
  silhouettes:         string[];
  key_pieces:          string[];
  avoids:              string[];
  occasion_mix: {
    casual:    number;
    work:      number;
    weekend:   number;
    going_out: number;
  };
  price_range:       "budget" | "mid" | "luxury";
  mood:              string;
  summary:           string;
  style_keywords:    string[];
  style_references:  StyleReference[];   // cultural anchors
  category_queries:  CategoryQueries;    // per-category search queries
}

// Alias for backwards compat
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
  editorial_intro: string;  // 2-sentence fashion-magazine intro
  edit_rationale:  string;  // 1 sentence: why these 6 cohere as a wardrobe
}

// ── Client ────────────────────────────────────────────────────────────────────

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ── Step 1: Deep aesthetic analysis ──────────────────────────────────────────

export async function analyzeAesthetic(
  boardName: string,
  pinDescriptions: string[]
): Promise<StyleDNA> {
  const client = getClient();

  const pinText = pinDescriptions
    .slice(0, 40)
    .map((d, i) => `${i + 1}. ${d}`)
    .join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `You are a world-class fashion stylist and aesthetic analyst. You have deep knowledge of contemporary fashion subcultures (quiet luxury, dark academia, coastal grandmother, clean girl, old money prep, boho maximalist, Y2K revival, mob wife glam, indie sleaze, balletcore, cottagecore, eclectic grandma, Scandi minimalist, Italian casual, Parisian effortless, etc.), color theory, silhouette psychology, and how aesthetics translate to actual shoppable garments.

Analyze this Pinterest board called "${boardName}":

${pinText}

Return a deeply nuanced StyleDNA JSON. Be highly specific and fashion-literate. Use precise vocabulary. Reference named aesthetics. Avoid generic descriptions.

Return ONLY valid JSON, no explanation:

{
  "primary_aesthetic": "specific named aesthetic, e.g. 'quiet luxury minimalist', 'coastal grandmother', 'dark academia', 'clean girl', 'old money prep'",
  "secondary_aesthetic": "secondary influence, e.g. 'with Parisian casual undertones'",
  "color_palette": ["5-6 very specific color names — e.g. 'warm ivory', 'dusty sage', 'caramel', 'slate blue' — never just 'beige' or 'blue'"],
  "silhouettes": ["4-5 silhouette preferences, e.g. 'relaxed wide-leg trouser', 'flowy bias-cut midi', 'oversized boxy top'"],
  "key_pieces": ["5-6 specific hero garments, e.g. 'linen wrap dress', 'structured leather blazer', 'bias-cut slip skirt'"],
  "avoids": ["3-4 explicit avoids, e.g. 'heavy logos', 'neon colors', 'shiny polyester'"],
  "occasion_mix": { "casual": 40, "work": 20, "weekend": 30, "going_out": 10 },
  "price_range": "budget | mid | luxury",
  "mood": "3-4 word evocative mood phrase, e.g. 'effortlessly refined, unhurried'",
  "summary": "2-3 sentences describing this person's style in an aspirational, editorial voice — like a stylist briefing a fashion shoot",
  "style_keywords": ["8-10 specific searchable fashion terms"],
  "style_references": [
    { "name": "celebrity or cultural figure name", "era": "specific era and context", "why": "one sentence on why this reference fits this exact board" },
    { "name": "...", "era": "...", "why": "..." }
  ],
  "category_queries": {
    "dress": ["2-3 targeted queries for dresses/jumpsuits only — combine color+fabric+silhouette+length, e.g. 'ivory bias-cut midi slip dress', 'dusty sage linen wrap dress'"],
    "top": ["2-3 queries for tops/blouses/knitwear only — e.g. 'oversized ribbed cream knit top', 'ivory linen relaxed button-down'"],
    "bottom": ["2-3 queries for skirts/trousers only — e.g. 'wide-leg camel linen trouser', 'bias-cut satin midi skirt cream'"],
    "jacket": ["2-3 queries for outerwear/blazers/cardigans — e.g. 'oversized camel wool coat', 'chunky ecru knit cardigan'"],
    "shoes": ["2-3 queries for footwear — e.g. 'tan leather strappy heeled sandal', 'cream leather pointed ballet flat'"],
    "bag": ["2-3 queries for bags — e.g. 'woven raffia natural tote', 'tan leather mini structured shoulder bag'"]
  }
}`,
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  return JSON.parse(json) as StyleDNA;
}

// ── Step 2: Category-aware Algolia search ─────────────────────────────────────
// Runs 6 parallel category buckets so Claude always has options across
// every garment type. Structurally prevents "6 dresses" problem.

export async function fetchCandidateProductsByCategory(
  dna: StyleDNA
): Promise<CategoryCandidates> {
  const queries = dna.category_queries;

  // Fallback if category_queries somehow missing
  if (!queries) {
    const flat = await searchByMultipleQueries(
      dna.style_keywords.slice(0, 8),
      dna.style_keywords,
      dna.price_range,
      20
    );
    // Distribute flat results across categories as best we can
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

  return searchByCategory(
    queries as Record<ClothingCategory, string[]>,
    dna.style_keywords,
    dna.price_range,
    5  // 5 candidates per category = 30 total for Claude to choose from
  );
}

// ── Step 3: Claude curates real products with outfit logic ────────────────────
// Claude sees candidates grouped by category, picks exactly 1 per category,
// groups into 2 outfits of 3, writes how_to_wear referencing other pieces,
// and produces an editorial intro + edit rationale.

export async function curateProducts(
  dna: StyleDNA,
  candidates: CategoryCandidates
): Promise<CurationResult> {
  const categories: ClothingCategory[] = ["dress", "top", "bottom", "jacket", "shoes", "bag"];

  // Check if we have enough candidates
  const totalCandidates = categories.reduce((sum, cat) => sum + candidates[cat].length, 0);
  if (totalCandidates === 0) {
    return { products: [], editorial_intro: "", edit_rationale: "" };
  }

  const client = getClient();

  // Build a compact, clearly labelled product list per category
  const categoryBlocks = categories.map((cat) => {
    const pool = candidates[cat];
    if (pool.length === 0) return `${cat.toUpperCase()}: (no results found)`;
    const items = pool.slice(0, 5).map((p, i) => ({
      idx:        i,
      title:      p.title,
      brand:      p.brand,
      description:(p.description || "").slice(0, 100),
      color:      p.color,
      material:   (p.material || "").slice(0, 60),
      price_range:p.price_range,
      retailer:   p.retailer,
    }));
    return `${cat.toUpperCase()} (${pool.length} options):\n${JSON.stringify(items, null, 1)}`;
  }).join("\n\n");

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `You are a personal stylist building a tightly edited, shoppable wardrobe for a specific client.

CLIENT PROFILE:
Aesthetic: ${dna.primary_aesthetic}${dna.secondary_aesthetic ? ` — ${dna.secondary_aesthetic}` : ""}
Mood: ${dna.mood}
Color palette: ${dna.color_palette.join(", ")}
They reach for: ${dna.key_pieces.join(", ")}
They avoid: ${dna.avoids.join(", ")}
Budget: ${dna.price_range}
Style: ${dna.summary}
${dna.style_references?.length ? `Inspired by: ${dna.style_references.map(r => `${r.name} (${r.era})`).join(", ")}` : ""}

AVAILABLE PRODUCTS BY CATEGORY:
${categoryBlocks}

YOUR TASK:
Select exactly 1 product from each category (6 total). Group them into 2 complete outfits (Outfit A and Outfit B), 3 pieces each. No two items of the same category in one outfit.

Outfit A suggestion: dress or top + bottom + jacket or shoes
Outfit B suggestion: remaining pieces that work together

Rules:
1. Genuine aesthetic fit — not keyword matching. Would this actually live in their wardrobe?
2. Color coherence — the 6 pieces should feel like one palette.
3. Hard filter — eliminate anything on their avoids list.
4. how_to_wear must be concrete and reference another specific product by name. "Pair with jeans" is rejected.
5. At least 4 of 6 how_to_wear tips must name another product from the selection.

Return ONLY valid JSON:
{
  "editorial_intro": "Exactly 2 sentences in a fashion-magazine voice — describe this edit and its mood. Make it feel personal and specific to this aesthetic.",
  "edit_rationale": "Exactly 1 sentence explaining why these 6 pieces work as a wardrobe together.",
  "selections": [
    {
      "category": "dress",
      "idx": 0,
      "outfit_group": "outfit_a",
      "outfit_role": "statement piece | base layer | layer | going-out look | weekend staple | workwear piece",
      "style_note": "One confident sentence — why this piece was chosen for them specifically. Fashion-forward, personal.",
      "how_to_wear": "Concrete styling tip referencing another specific product by name from your selections."
    }
  ]
}`,
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";

  type RawResult = {
    editorial_intro: string;
    edit_rationale:  string;
    selections: Array<{
      category:    string;
      idx:         number;
      outfit_group: OutfitGroup;
      outfit_role: string;
      style_note:  string;
      how_to_wear: string;
    }>;
  };

  let raw: RawResult;
  try {
    raw = JSON.parse(json) as RawResult;
  } catch {
    // Parse failure — return flat fallback
    const fallback = categories.flatMap((cat) =>
      candidates[cat].slice(0, 1).map((p, i) => ({
        ...p,
        style_note:   `A considered pick for your ${dna.primary_aesthetic} aesthetic.`,
        outfit_role:  "versatile staple",
        outfit_group: (i % 2 === 0 ? "outfit_a" : "outfit_b") as OutfitGroup,
        how_to_wear:  "Style with other pieces from your edit.",
      }))
    );
    return { products: fallback, editorial_intro: "", edit_rationale: "" };
  }

  const products: CuratedProduct[] = (raw.selections ?? [])
    .filter((s) => {
      const cat = s.category as ClothingCategory;
      return categories.includes(cat) && typeof s.idx === "number" && s.idx < (candidates[cat]?.length ?? 0);
    })
    .slice(0, 6)
    .map((s) => {
      const cat = s.category as ClothingCategory;
      const product = candidates[cat][s.idx];
      return {
        ...product,
        style_note:   s.style_note  ?? "",
        outfit_role:  s.outfit_role ?? "versatile staple",
        outfit_group: s.outfit_group ?? "outfit_a",
        how_to_wear:  s.how_to_wear ?? "",
      };
    });

  // Pad if curation returned fewer than expected
  if (products.length < 6) {
    const usedIds = new Set(products.map((p) => p.objectID));
    for (const cat of categories) {
      if (products.length >= 6) break;
      const extra = candidates[cat].find((p) => !usedIds.has(p.objectID));
      if (extra) {
        usedIds.add(extra.objectID);
        products.push({
          ...extra,
          style_note:   `A considered pick for your ${dna.primary_aesthetic} aesthetic.`,
          outfit_role:  "versatile staple",
          outfit_group: "outfit_b",
          how_to_wear:  "Style with other pieces from your edit.",
        });
      }
    }
  }

  return {
    products,
    editorial_intro: raw.editorial_intro ?? "",
    edit_rationale:  raw.edit_rationale  ?? "",
  };
}

// Legacy alias
export async function findProducts(dna: StyleDNA): Promise<AlgoliaProduct[]> {
  const candidates = await fetchCandidateProductsByCategory(dna);
  const result = await curateProducts(dna, candidates);
  return result.products;
}
