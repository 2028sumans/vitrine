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
import type { StyleAxesDelta } from "@/lib/types";

export interface SteerInterpretation {
  search_terms: string[];
  avoid_terms:  string[];
  price_range:  "budget" | "mid" | "luxury" | null;
  categories:   string[];
  colors:       string[];
  /**
   * Signed deltas on the 5 pre-computed style axes stored in Pinecone metadata.
   * Each value is in [-1, 1] — e.g. "more minimalist" → { minimalism: +0.35 }.
   * Empty when the user's instruction doesn't map to an axis.
   */
  style_axes:   StyleAxesDelta;
  intent:       string;
}

const EMPTY: SteerInterpretation = {
  search_terms: [],
  avoid_terms:  [],
  price_range:  null,
  categories:   [],
  colors:       [],
  style_axes:   {},
  intent:       "",
};

const AXIS_KEYS = new Set(["formality", "minimalism", "edge", "romance", "drape"]);

function sanitizeAxes(raw: unknown): StyleAxesDelta {
  if (!raw || typeof raw !== "object") return {};
  const out: StyleAxesDelta = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!AXIS_KEYS.has(k)) continue;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    if (!Number.isFinite(n)) continue;
    out[k as keyof StyleAxesDelta] = Math.max(-1, Math.min(1, n));
  }
  return out;
}

const PROMPT = `You are a shopping-feed refinement interpreter. The user just typed a short free-text instruction to refine their clothing feed. Convert it into structured JSON.

Examples of how to interpret:
  "cheaper"                        → { "price_range": "budget" }
  "under 200"                      → { "price_range": "budget" }
  "more expensive" / "luxury"      → { "price_range": "luxury" }
  "mid-range"                      → { "price_range": "mid" }
  "black only"                     → { "colors": ["black"] }
  "black dresses"                  → { "colors": ["black"], "categories": ["dress"], "search_terms": ["black dress"] }
  "no florals"                     → { "avoid_terms": ["floral", "flower"] }
  "more minimalist"                → { "search_terms": ["minimalist", "clean", "simple"], "style_axes": { "minimalism": 0.35 } }
  "show me bags"                   → { "categories": ["bag"], "search_terms": ["bag"] }
  "cheaper blazers"                → { "price_range": "budget", "categories": ["jacket"], "search_terms": ["blazer"] }
  "more linen, less denim"         → { "search_terms": ["linen"], "avoid_terms": ["denim", "jean"] }
  "edgier"                         → { "search_terms": ["edgy", "leather"], "style_axes": { "edge": 0.35 } }
  "dressier"                       → { "style_axes": { "formality": 0.3 } }
  "less flowy, more structured"    → { "style_axes": { "drape": -0.3 } }
  "softer, more romantic"          → { "style_axes": { "romance": 0.3, "edge": -0.2 } }
  "way more minimalist"            → { "search_terms": ["minimalist"], "style_axes": { "minimalism": 0.6 } }

Valid categories: dress, top, bottom, jacket, shoes, bag, accessory.
Valid colors: concrete color words only ("black", "cream", "navy") — not abstract aesthetics ("moody", "clean").
Valid price_range values: "budget", "mid", "luxury", or null.

style_axes — each key is optional; value is signed delta in [-1, 1]:
  formality  : positive = dressier,      negative = more casual
  minimalism : positive = stripped-back, negative = more embellished
  edge       : positive = harder/edgier, negative = softer
  romance    : positive = flowy/feminine, negative = tailored/strict
  drape      : positive = fluid/flowing, negative = structured/stiff

Use style_axes ONLY for abstract vibe moves ("edgier", "more minimalist", "softer"). Concrete swaps ("no florals", "black only") use the other fields. Use ~0.3 for typical shifts, ~0.6 for strong modifiers ("way more", "much").

IMPORTANT:
- Only fill fields the user actually implied. Leave the rest as empty arrays / null / {}.
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
  "style_axes":   {},
  "intent":       "one sentence plaintext interpretation"
}`;

export interface InterpretOptions {
  /** Most-recent-first list of the user's previous steers in the current
   *  context. Optionally injected into the prompt as one-line history so
   *  Claude can resolve "more like before" / "less of what I asked for"
   *  references. Empty / missing array → no history block in the prompt. */
  recentSteers?: string[];
}

export async function interpretSteerText(
  text:    string,
  options: InterpretOptions = {},
): Promise<SteerInterpretation> {
  const trimmed = text.trim();
  if (!trimmed) return EMPTY;
  if (!process.env.ANTHROPIC_API_KEY) {
    // Degrade gracefully: treat as raw search terms so at least partial
    // search still works when Claude is unavailable.
    return { ...EMPTY, search_terms: trimmed.split(/\s+/).filter(Boolean), intent: trimmed };
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build the prompt with optional recent-steer history.
    // The history block is intentionally compact — Claude doesn't need
    // structured interps, just the raw lines for coreference resolution.
    const recent = (options.recentSteers ?? []).filter(Boolean).slice(0, 3);
    const historyBlock = recent.length > 0
      ? `\nThe user's most recent prior steers in this session (most recent first):\n${recent.map((s, i) => `  ${i + 1}. "${s}"`).join("\n")}\nIf the current input refers back ("more like the last one", "less of what I just asked"), interpret in that context.\n`
      : "";

    const filledPrompt = PROMPT.replace("{{TEXT}}", trimmed) + historyBlock;

    const message = await client.messages.create({
      model:      "claude-haiku-4-5",
      max_tokens: 500,
      messages:   [{ role: "user", content: filledPrompt }],
    });

    const raw  = message.content[0]?.type === "text" ? message.content[0].text : "";
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return { ...EMPTY, search_terms: trimmed.split(/\s+/).filter(Boolean), intent: trimmed };

    const parsed = JSON.parse(json) as Partial<SteerInterpretation> & { style_axes?: unknown };
    return {
      search_terms: Array.isArray(parsed.search_terms) ? parsed.search_terms.filter((t) => typeof t === "string") : [],
      avoid_terms:  Array.isArray(parsed.avoid_terms)  ? parsed.avoid_terms.filter((t)  => typeof t === "string")  : [],
      price_range:  parsed.price_range === "budget" || parsed.price_range === "mid" || parsed.price_range === "luxury" ? parsed.price_range : null,
      categories:   Array.isArray(parsed.categories)  ? parsed.categories.filter((t)   => typeof t === "string")   : [],
      colors:       Array.isArray(parsed.colors)      ? parsed.colors.filter((t)       => typeof t === "string")       : [],
      style_axes:   sanitizeAxes(parsed.style_axes),
      intent:       typeof parsed.intent === "string" ? parsed.intent : trimmed,
    };
  } catch (err) {
    console.warn("[steer-interpret] fell back to literal terms:", err instanceof Error ? err.message : err);
    return { ...EMPTY, search_terms: trimmed.split(/\s+/).filter(Boolean), intent: trimmed };
  }
}
