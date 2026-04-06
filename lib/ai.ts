import Anthropic from "@anthropic-ai/sdk";
import { searchByMultipleQueries, type AlgoliaProduct } from "@/lib/algolia";

export interface AestheticProfile {
  mood: string;
  colors: string[];
  materials: string[];
  style_keywords: string[];
  price_range: "budget" | "mid" | "luxury";
  summary: string;
  search_queries: string[];
}

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
  "summary": "2 sentences describing the aesthetic in plain English",
  "search_queries": ["6 specific clothing search queries to find products matching this aesthetic — use terms like 'linen midi dress', 'oversized blazer beige', 'floral wrap dress', 'ribbed knit top cream', etc."]
}`,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  return JSON.parse(json) as AestheticProfile;
}

// ── Step 2: Find real products via Algolia ────────────────────────────────────

export async function findProducts(
  aesthetic: AestheticProfile
): Promise<AlgoliaProduct[]> {
  const queries = aesthetic.search_queries?.length
    ? aesthetic.search_queries
    : aesthetic.style_keywords.slice(0, 6);

  return searchByMultipleQueries(
    queries,
    aesthetic.style_keywords,
    aesthetic.price_range
  );
}
