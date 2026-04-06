import Anthropic from "@anthropic-ai/sdk";

export interface AestheticProfile {
  mood: string;
  colors: string[];
  materials: string[];
  style_keywords: string[];
  price_range: "budget" | "mid" | "luxury";
  summary: string;
}

export interface ProductRecommendation {
  name: string;
  category: string;
  description: string;
  price_range: string;
  retailers: string[];
  search_query: string;
  amazon_url: string;
}

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function buildAmazonUrl(searchQuery: string): string {
  const tag = process.env.AMAZON_ASSOCIATE_TAG ?? "vitrine-20";
  const encoded = encodeURIComponent(searchQuery);
  return `https://www.amazon.com/s?k=${encoded}&tag=${tag}`;
}

// ── Step 1: Analyze board aesthetic ──────────────────────────────────────────

export async function analyzeAesthetic(
  boardName: string,
  pinDescriptions: string[]
): Promise<AestheticProfile> {
  const client = getClient();

  const pinText = pinDescriptions
    .slice(0, 40)
    .map((d, i) => `${i + 1}. ${d}`)
    .join("\n");

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You are an expert style and aesthetic analyst.

Analyze this Pinterest board called "${boardName}". Here are descriptions of pins from the board:

${pinText}

Based on these pins, return a JSON object describing the aesthetic. Be specific and accurate. Return ONLY valid JSON, no explanation.

{
  "mood": "2-3 word vibe, e.g. warm minimalist",
  "colors": ["4-5 dominant color names"],
  "materials": ["4-6 key materials or textures"],
  "style_keywords": ["6-8 searchable style terms"],
  "price_range": "budget | mid | luxury",
  "summary": "2 sentences describing the aesthetic in plain English"
}`,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  return JSON.parse(json) as AestheticProfile;
}

// ── Step 2: Generate product recommendations ──────────────────────────────────

export async function recommendProducts(
  boardName: string,
  aesthetic: AestheticProfile
): Promise<ProductRecommendation[]> {
  const client = getClient();

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `You are a personal shopper with expert knowledge of home decor, fashion, and lifestyle products.

A user has a Pinterest board called "${boardName}" with this aesthetic profile:
- Mood: ${aesthetic.mood}
- Colors: ${aesthetic.colors.join(", ")}
- Materials: ${aesthetic.materials.join(", ")}
- Style: ${aesthetic.style_keywords.join(", ")}
- Price range: ${aesthetic.price_range}
- Summary: ${aesthetic.summary}

Recommend exactly 6 specific shoppable products that match this aesthetic perfectly. Be very specific with product names — not generic. Return ONLY a valid JSON array, no explanation.

[
  {
    "name": "specific product name",
    "category": "e.g. Accent Chair, Table Lamp, Throw Pillow",
    "description": "1 sentence on why it fits this aesthetic",
    "price_range": "e.g. $45–$75",
    "retailers": ["2-3 retailers likely to carry it"],
    "search_query": "exact Amazon search string to find this product"
  }
]`,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.match(/\[[\s\S]*\]/)?.[0] ?? "[]";
  const products = JSON.parse(json) as Omit<ProductRecommendation, "amazon_url">[];

  return products.map((p) => ({
    ...p,
    amazon_url: buildAmazonUrl(p.search_query),
  }));
}
