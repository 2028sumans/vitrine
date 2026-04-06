import Anthropic from "@anthropic-ai/sdk";
import { searchByMultipleQueries, type AlgoliaProduct } from "@/lib/algolia";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StyleDNA {
  primary_aesthetic: string;
  secondary_aesthetic: string;
  color_palette: string[];
  silhouettes: string[];
  key_pieces: string[];
  avoids: string[];
  occasion_mix: {
    casual: number;
    work: number;
    weekend: number;
    going_out: number;
  };
  price_range: "budget" | "mid" | "luxury";
  mood: string;
  summary: string;
  style_keywords: string[];
  search_queries: string[];
}

// Alias for any code that still uses the old name
export type AestheticProfile = StyleDNA;

export interface CuratedProduct extends AlgoliaProduct {
  style_note: string;
  outfit_role: string;
}

// ── Client ────────────────────────────────────────────────────────────────────

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ── Step 1: Deep aesthetic analysis ──────────────────────────────────────────
// Claude reads the board and builds a rich StyleDNA — named aesthetic,
// specific color palette, silhouettes, hero garments, avoids, occasion mix,
// and 8 targeted Algolia search queries.

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
    max_tokens: 1600,
    messages: [
      {
        role: "user",
        content: `You are a world-class fashion stylist and aesthetic analyst. You have deep knowledge of contemporary fashion subcultures (quiet luxury, dark academia, coastal grandmother, clean girl, old money prep, boho maximalist, Y2K revival, mob wife glam, indie sleaze, balletcore, cottagecore, eclectic grandma, Scandi minimalist, Italian casual, etc.), color theory, silhouette psychology, and how aesthetics translate to actual shoppable garments.

Analyze this Pinterest board called "${boardName}":

${pinText}

Return a deeply nuanced StyleDNA JSON. Be highly specific and fashion-literate. Use precise vocabulary. Reference named aesthetics. Avoid generic descriptions — e.g. not "blue" but "dusty slate blue"; not "casual" but "effortlessly undone".

Return ONLY valid JSON, no explanation:

{
  "primary_aesthetic": "specific named aesthetic, e.g. 'quiet luxury minimalist', 'coastal grandmother', 'dark academia', 'clean girl', 'old money prep', 'Y2K revival', 'mob wife glam', 'indie sleaze', 'balletcore', 'cottagecore maximalist'",
  "secondary_aesthetic": "secondary influence or blend, e.g. 'with Parisian casual undertones' or 'meets 70s boho revival'",
  "color_palette": ["5-6 very specific color names — e.g. 'warm ivory', 'dusty sage', 'caramel', 'slate blue', 'terracotta amber' — never just 'beige' or 'blue'"],
  "silhouettes": ["4-5 silhouette preferences, e.g. 'relaxed wide-leg trouser', 'flowy bias-cut midi', 'oversized boxy top', 'fitted bodycon mini', 'structured A-line skirt'"],
  "key_pieces": ["5-6 specific hero garments, e.g. 'linen wrap dress', 'structured leather blazer', 'bias-cut slip skirt', 'chunky ribbed cardigan', 'tailored wide-leg trouser'"],
  "avoids": ["3-4 explicit avoids for this aesthetic, e.g. 'heavy logos', 'neon colors', 'micro minis', 'fast fashion prints', 'shiny polyester'"],
  "occasion_mix": { "casual": 40, "work": 20, "weekend": 30, "going_out": 10 },
  "price_range": "budget | mid | luxury",
  "mood": "3-4 word evocative mood phrase, e.g. 'effortlessly refined, unhurried' or 'electric, maximalist, unapologetic'",
  "summary": "2-3 sentences describing this person's style in an aspirational, editorial voice — like a stylist briefing a fashion shoot. Make it feel personal and considered.",
  "style_keywords": ["8-10 specific searchable fashion terms that capture this aesthetic"],
  "search_queries": [
    "8 highly targeted search strings for a fashion product database. Each should combine color + fabric + garment + silhouette for precision. Examples: 'cream linen wide-leg pants', 'dusty rose silk midi slip dress', 'oversized camel wool blazer', 'ribbed knit cream crop top', 'floral wrap midi dress boho', 'satin slip skirt neutral tone', 'relaxed linen button-down shirt', 'black leather structured mini skirt'"
  ]
}`,
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  return JSON.parse(json) as StyleDNA;
}

// ── Step 2: Fetch candidate products from Algolia ─────────────────────────────
// Run 8 search queries in parallel, pull back ~20 candidates for curation.

export async function fetchCandidateProducts(
  dna: StyleDNA
): Promise<AlgoliaProduct[]> {
  const queries = dna.search_queries?.length
    ? dna.search_queries
    : dna.style_keywords.slice(0, 8);

  return searchByMultipleQueries(
    queries,
    dna.style_keywords,
    dna.price_range,
    20 // fetch 20 so Claude has real choices to curate from
  );
}

// ── Step 3: Claude curates real products ─────────────────────────────────────
// Claude sees the actual products from Algolia and applies stylist judgment:
// picks the best 6, ensures category balance and color coherence,
// eliminates anything clashing with the aesthetic, writes a personal style note.

export async function curateProducts(
  dna: StyleDNA,
  candidates: AlgoliaProduct[]
): Promise<CuratedProduct[]> {
  if (candidates.length === 0) return [];

  // If not enough to curate, return all with basic notes
  if (candidates.length <= 6) {
    return candidates.map((p) => ({
      ...p,
      style_note: `A considered pick for your ${dna.primary_aesthetic} aesthetic.`,
      outfit_role: "versatile staple",
    }));
  }

  const client = getClient();

  // Compact product list — truncate descriptions to keep tokens manageable
  const productList = candidates.slice(0, 20).map((p, i) => ({
    idx: i,
    title: p.title,
    brand: p.brand,
    description: (p.description || "").slice(0, 110),
    color: p.color,
    material: (p.material || "").slice(0, 80),
    price_range: p.price_range,
    retailer: p.retailer,
    tags: (p.aesthetic_tags || []).slice(0, 5),
  }));

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1400,
    messages: [
      {
        role: "user",
        content: `You are a personal stylist curating a tightly edited shopping selection for a specific client.

CLIENT PROFILE:
Aesthetic: ${dna.primary_aesthetic}${dna.secondary_aesthetic ? ` — ${dna.secondary_aesthetic}` : ""}
Mood: ${dna.mood}
Color palette: ${dna.color_palette.join(", ")}
They love wearing: ${dna.key_pieces.join(", ")}
They avoid: ${dna.avoids.join(", ")}
Budget: ${dna.price_range}
Style summary: ${dna.summary}

PRODUCTS AVAILABLE:
${JSON.stringify(productList, null, 1)}

Your job: select the BEST 6 products for this client using real stylist judgment.

Rules:
1. Genuine aesthetic fit — not just keyword matching. Ask: would this actually look at home in their wardrobe?
2. Category balance — vary the types (e.g. a dress OR separates, a layer, different occasions). No 6 dresses.
3. Color coherence — pieces should feel like they belong to the same palette.
4. Hard filter — eliminate anything in their avoids list, even if it otherwise fits.
5. Edit ruthlessly — a piece that's 95% right is better than one that's 70% right.

Return ONLY a JSON array of exactly 6:
[
  {
    "idx": <number from the list>,
    "style_note": "One confident, specific sentence explaining why this piece was chosen for them. Be fashion-forward and personal. Example: 'The relaxed linen silhouette and warm ivory tone align perfectly with the effortless, unhurried quality running through your board.'",
    "outfit_role": "one of: statement piece | base layer | layer | going-out look | weekend staple | workwear piece"
  }
]`,
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.match(/\[[\s\S]*\]/)?.[0] ?? "[]";

  type Selection = { idx: number; style_note: string; outfit_role: string };
  let selections: Selection[] = [];

  try {
    selections = JSON.parse(json) as Selection[];
  } catch {
    // Curation parse failed — return first 6 with generic notes
    return candidates.slice(0, 6).map((p) => ({
      ...p,
      style_note: `A considered pick for your ${dna.primary_aesthetic} aesthetic.`,
      outfit_role: "versatile staple",
    }));
  }

  const curated = selections
    .filter((s) => typeof s.idx === "number" && s.idx >= 0 && s.idx < candidates.length)
    .slice(0, 6)
    .map((s) => ({
      ...candidates[s.idx],
      style_note: s.style_note,
      outfit_role: s.outfit_role,
    }));

  // If curation returned fewer than expected (bad parse), pad with ungrouped candidates
  if (curated.length < Math.min(6, candidates.length)) {
    const usedIdx = new Set(curated.map((p) => p.objectID));
    const extras = candidates
      .filter((p) => !usedIdx.has(p.objectID))
      .slice(0, 6 - curated.length)
      .map((p) => ({
        ...p,
        style_note: `A considered pick for your ${dna.primary_aesthetic} aesthetic.`,
        outfit_role: "versatile staple" as string,
      }));
    return [...curated, ...extras];
  }

  return curated;
}
