/**
 * Claude Haiku interprets free-text Steer input ("cheaper", "no florals",
 * "more minimalist blazers") and returns structured filters the /api/shop-all
 * route can apply:
 *
 *   price_range   → post-filter products against this tier (budget|mid|luxury)
 *   categories    → bias towards these category strings
 *   colors        → bias towards these color strings
 *   search_terms  → passed into Algolia's query + optionalWords
 *   avoid_terms   → substring post-filter against title/category/color
 *   intent        → one-sentence plaintext summary (used for UI / debug)
 *
 * The key win over raw text search: "cheaper" stops matching titles containing
 * the literal word "cheaper" (zero hits) and starts actually lowering the
 * price tier.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface SteerInterpretation {
  search_terms: string[];
  avoid_terms:  string[];
  price_range:  "budget" | "mid" | "luxury" | null;
  categories:   string[];
  colors:       string[];
  intent:       string;
}

const EMPTY: SteerInterpretation = {
  search_terms: [],
  avoid_terms:  [],
  price_range:  null,
  categories:   [],
  colors:       [],
  intent:       "",
};

const PROMPT = `You are a shopping-feed refinement interpreter. The user just typed a short free-text instruction to refine their clothing feed. Convert it into structured JSON.

Examples of how to interpret:
  "cheaper"                        → { "price_range": "budget" }
  "under 200"                      → { "price_range": "budget" }
  "more expensive" / "luxury"      → { "price_range": "luxury" }
  "mid-range"                      → { "price_range": "mid" }
  "black only"                     → { "colors": ["black"] }
  "black dresses"                  → { "colors": ["black"], "categories": ["dress"], "search_terms": ["black dress"] }
  "no florals"                     → { "avoid_terms": ["floral", "flower"] }
  "more minimalist"                → { "search_terms": ["minimalist", "clean", "simple"] }
  "show me bags"                   → { "categories": ["bag"], "search_terms": ["bag"] }
  "cheaper blazers"                → { "price_range": "budget", "categories": ["jacket"], "search_terms": ["blazer"] }
  "more linen, less denim"         → { "search_terms": ["linen"], "avoid_terms": ["denim", "jean"] }
  "edgier"                         → { "search_terms": ["edgy", "punk", "grunge", "leather"] }

Valid categories: dress, top, bottom, jacket, shoes, bag, accessory.
Valid colors: concrete color words only ("black", "cream", "navy") — not abstract aesthetics ("moody", "clean").
Valid price_range values: "budget", "mid", "luxury", or null.

IMPORTANT:
- Only fill fields the user actually implied. Leave the rest as empty arrays / null.
- Never echo the raw input as a search_term unless it's also a concrete fashion word.
- If the instruction is too vague or unfashion ("idk", "whatever"), return everything empty.

User's instruction: "{{TEXT}}"

Return ONLY valid JSON, no preamble:
{
  "price_range": "budget" | "mid" | "luxury" | null,
  "categories":  [],
  "colors":      [],
  "search_terms": [],
  "avoid_terms":  [],
  "intent":       "one sentence plaintext interpretation"
}`;

export async function interpretSteerText(text: string): Promise<SteerInterpretation> {
  const trimmed = text.trim();
  if (!trimmed) return EMPTY;
  if (!process.env.ANTHROPIC_API_KEY) {
    // Degrade gracefully: treat as raw search terms so at least partial
    // search still works when Claude is unavailable.
    return { ...EMPTY, search_terms: trimmed.split(/\s+/).filter(Boolean), intent: trimmed };
  }

  try {
    const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 500,
      messages:   [{ role: "user", content: PROMPT.replace("{{TEXT}}", trimmed) }],
    });

    const raw  = message.content[0]?.type === "text" ? message.content[0].text : "";
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return { ...EMPTY, search_terms: trimmed.split(/\s+/).filter(Boolean), intent: trimmed };

    const parsed = JSON.parse(json) as Partial<SteerInterpretation>;
    return {
      search_terms: Array.isArray(parsed.search_terms) ? parsed.search_terms.filter((t) => typeof t === "string") : [],
      avoid_terms:  Array.isArray(parsed.avoid_terms)  ? parsed.avoid_terms.filter((t)  => typeof t === "string")  : [],
      price_range:  parsed.price_range === "budget" || parsed.price_range === "mid" || parsed.price_range === "luxury" ? parsed.price_range : null,
      categories:   Array.isArray(parsed.categories)  ? parsed.categories.filter((t)   => typeof t === "string")   : [],
      colors:       Array.isArray(parsed.colors)      ? parsed.colors.filter((t)       => typeof t === "string")       : [],
      intent:       typeof parsed.intent === "string" ? parsed.intent : trimmed,
    };
  } catch (err) {
    console.warn("[steer-interpret] fell back to literal terms:", err instanceof Error ? err.message : err);
    return { ...EMPTY, search_terms: trimmed.split(/\s+/).filter(Boolean), intent: trimmed };
  }
}
