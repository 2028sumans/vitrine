/**
 * Client-side fast-parse for Steer / "say more" input.
 *
 * The server-side /api/steer-interpret route calls Claude Haiku to parse
 * abstract phrases like "edgier", "more minimalist", "softer and more
 * romantic" — that's ~1-2 s of latency on every submit. For 90% of actual
 * steers ("in black", "cheaper", "no florals", "show me bags"), the
 * structure is obvious and extractable by regex in 0 ms.
 *
 * Flow at the caller:
 *   1. fastParseSteerText(input)  →  heuristic parse
 *   2. If anything concrete matched (colors/categories/price/avoids/search),
 *      apply it immediately and skip Claude → INSTANT feedback.
 *   3. If heuristic parse is empty (input is abstract), fall back to Claude.
 *
 * Kept in a separate file so both the shop scroll views and dashboard scroll
 * view can share it, and the server can validate the same regex set if it
 * ever wants to merge server + client parses.
 */

import type { SteerInterpretation } from "@/lib/steer-interpret";

// ── Vocabularies ────────────────────────────────────────────────────────────

const COLOR_WORDS: ReadonlySet<string> = new Set([
  "black", "white", "red", "blue", "green", "pink", "yellow", "orange", "purple", "brown",
  "beige", "cream", "navy", "burgundy", "olive", "sage", "terracotta", "coral", "mauve", "lilac",
  "rust", "camel", "chocolate", "ivory", "gold", "silver", "leopard", "fuchsia", "magenta",
  "grey", "gray", "tan", "nude", "khaki", "plum", "teal", "aqua", "turquoise", "salmon",
  "mustard", "taupe", "lavender", "charcoal", "indigo", "cobalt", "emerald", "wine", "maroon",
  "peach", "apricot", "mint", "forest", "lime", "cherry", "blush", "champagne", "bronze",
]);

// Maps user-typed words to the canonical category buckets we use elsewhere.
// The shop/brands grid + scroll view read `categories[0]` and dashboard
// reads the array whole.
const CATEGORY_MAP: Readonly<Record<string, string>> = {
  dress:    "dress", dresses:   "dress", gown:      "dress", gowns:    "dress",
  top:      "top",   tops:      "top",   shirt:     "top",   shirts:   "top",
  blouse:   "top",   blouses:   "top",   tee:       "top",   tees:     "top",
  tank:     "top",   tanks:     "top",   sweater:   "top",   sweaters: "top",
  knit:     "top",   knits:     "top",   cardigan:  "top",   hoodie:   "top",
  hoodies:  "top",   sweatshirt:"top",
  pants:    "bottom",trousers:  "bottom",pant:      "bottom",trouser:  "bottom",
  skirt:    "bottom",skirts:    "bottom",jeans:     "bottom",jean:     "bottom",
  denim:    "bottom",short:     "bottom",shorts:    "bottom",
  jacket:   "jacket",jackets:   "jacket",blazer:    "jacket",blazers:  "jacket",
  coat:     "jacket",coats:     "jacket",outerwear: "jacket",trench:   "jacket",
  shoe:     "shoes", shoes:     "shoes", boot:      "shoes", boots:    "shoes",
  heel:     "shoes", heels:     "shoes", sneaker:   "shoes", sneakers: "shoes",
  loafer:   "shoes", loafers:   "shoes", sandal:    "shoes", sandals:  "shoes",
  bag:      "bag",   bags:      "bag",   tote:      "bag",   totes:    "bag",
  purse:    "bag",   purses:    "bag",   clutch:    "bag",   handbag:  "bag",
  backpack: "bag",   crossbody: "bag",
};

// ── Price buckets ───────────────────────────────────────────────────────────

const BUDGET_PHRASE = /\b(cheap(?:er)?|cheapest|budget|affordable|inexpensive)\b/i;
const LUXURY_PHRASE = /\b(luxury|luxe|expensive|high[- ]?end|premium|designer(?:\s+only)?|splurge)\b/i;
const MID_PHRASE    = /\b(mid[- ]?range|mid[- ]?tier|middle)\b/i;
const UNDER_DOLLAR  = /\bunder\s*\$?(\d{2,5})\b/i;
const OVER_DOLLAR   = /\bover\s*\$?(\d{2,5})\b/i;

function parsePriceRange(text: string): "budget" | "mid" | "luxury" | null {
  const under = text.match(UNDER_DOLLAR);
  if (under) {
    const n = parseInt(under[1], 10);
    if (n <= 150) return "budget";
    if (n <= 500) return "mid";
    return "luxury";
  }
  const over = text.match(OVER_DOLLAR);
  if (over) {
    const n = parseInt(over[1], 10);
    return n >= 500 ? "luxury" : "mid";
  }
  if (BUDGET_PHRASE.test(text)) return "budget";
  if (LUXURY_PHRASE.test(text)) return "luxury";
  if (MID_PHRASE.test(text))    return "mid";
  return null;
}

// ── Avoid / negation ────────────────────────────────────────────────────────
// Captures the 1-3 words immediately following a negation cue: "no florals",
// "without polka dots", "skip denim and linen". Stops at a comma / "and" /
// "but" / punctuation.

const NEGATION_CUES = /\b(?:no|not|without|skip|avoid|less|hate|don'?t\s+want|not\s+a\s+fan\s+of|ditch|nothing)\b/i;

function parseAvoids(text: string): string[] {
  const out = new Set<string>();
  // Find all negation cues and capture the following phrase
  const re = /\b(?:no|not|without|skip|avoid|less|hate|don'?t\s+want|not\s+a\s+fan\s+of|ditch|nothing)\s+([a-z][a-z0-9\s\-]{1,30})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Trim the captured phrase at the first conjunction/punct boundary.
    const phrase = m[1].toLowerCase().split(/[,.;!?]|\s(?:and|but|or|with|more|also)\s/)[0].trim();
    if (!phrase) continue;
    // Tokenise the phrase and add each non-stop word separately — "polka dots"
    // → ["polka", "dots"] helps Algolia avoid-filter hit more product titles.
    for (const tok of phrase.split(/\s+/)) {
      const clean = tok.replace(/s$/, "").trim(); // strip plural s: "florals" → "floral"
      if (clean.length >= 3 && !STOPWORDS.has(clean)) out.add(clean);
      // Also keep the original form — product text may be plural too.
      if (tok.length >= 3 && !STOPWORDS.has(tok)) out.add(tok);
    }
  }
  return Array.from(out);
}

const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "from",
  "i", "you", "we", "they", "it", "this", "that", "these", "those",
  "more", "less", "very", "some", "any", "all", "kind", "sort", "thing", "things",
  "want", "like", "show", "me", "please", "really", "super",
]);

// ── Abstract vibe words (signal we should defer to Claude) ──────────────────
// These are style modifiers that FashionCLIP / Claude understand but regex
// can't map to concrete filters. If the input's ONLY content word is one of
// these, fast parse will return empty and the caller falls back to Claude.

const ABSTRACT_VIBE: ReadonlySet<string> = new Set([
  "edgy", "edgier", "soft", "softer", "hard", "harder",
  "romantic", "minimal", "minimalist", "minimalism", "clean", "structured",
  "relaxed", "oversized", "tight", "fitted", "loose",
  "flowy", "drapey", "crisp", "sharp", "polished", "casual", "formal",
  "formal", "dressy", "dressier", "fancier", "classier",
  "boho", "bohemian", "preppy", "grunge", "classic", "timeless",
  "feminine", "masculine", "androgynous", "tomboy",
  "quiet", "loud", "bold", "understated", "subtle", "striking",
  "sexy", "cute", "chic", "elegant", "refined", "cool", "trendy",
]);

// ── Core ────────────────────────────────────────────────────────────────────

export interface FastParseResult extends SteerInterpretation {
  /** True when any field has content. Callers use this to decide whether
   *  to apply immediately or defer to the server parse. */
  isConcrete: boolean;
  /** True when the input looks like an abstract vibe move ("edgier",
   *  "more romantic"). The caller should call Claude in that case — or
   *  at minimum still apply search_terms if present. */
  isAbstract: boolean;
}

export function fastParseSteerText(raw: string): FastParseResult {
  const text  = raw.trim();
  const lower = text.toLowerCase();
  const tokens = lower
    .replace(/[^a-z0-9\s\-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const colors: string[]     = [];
  const categories: string[] = [];
  const searchTerms: string[]= [];

  for (const tok of tokens) {
    if (COLOR_WORDS.has(tok)) colors.push(tok);
    const cat = CATEGORY_MAP[tok];
    if (cat) categories.push(cat);
  }

  // "more linen" / "more silk" → search term (fabric / material cue).
  // We deliberately skip abstract vibes here — those need Claude.
  const moreRe = /\b(?:more|lots?\s+of|show\s+me)\s+([a-z][a-z\-]{2,20})/gi;
  let mm: RegExpExecArray | null;
  while ((mm = moreRe.exec(lower)) !== null) {
    const w = mm[1].toLowerCase();
    if (ABSTRACT_VIBE.has(w)) continue;     // "more minimalist" → defer
    if (STOPWORDS.has(w))     continue;
    if (CATEGORY_MAP[w] || COLOR_WORDS.has(w)) continue; // already captured
    searchTerms.push(w);
  }

  const priceRange = parsePriceRange(lower);
  const avoidTerms = parseAvoids(lower);

  // Did the user say something abstract? (Used to decide whether the
  // caller should still kick Claude after applying fast result.)
  const hasAbstract = tokens.some((t) => ABSTRACT_VIBE.has(t))
    || /\b(more|less|way)\s+[a-z]+/i.test(lower)
    && !colors.length && !categories.length && !priceRange && !avoidTerms.length;

  const dedupe = (arr: string[]) => Array.from(new Set(arr));
  const result: FastParseResult = {
    search_terms: dedupe(searchTerms),
    avoid_terms:  dedupe(avoidTerms),
    price_range:  priceRange,
    categories:   dedupe(categories),
    colors:       dedupe(colors),
    style_axes:   {},
    intent:       text,
    isConcrete:   false,
    isAbstract:   hasAbstract,
  };

  result.isConcrete =
    result.colors.length > 0 ||
    result.categories.length > 0 ||
    result.avoid_terms.length > 0 ||
    result.search_terms.length > 0 ||
    result.price_range !== null;

  return result;
}

// ── Merge helper ────────────────────────────────────────────────────────────
// When BOTH fast parse and Claude produce results, merge by taking the union
// of concrete fields and preferring Claude's style_axes (regex can't produce
// those). Used by callers that apply fast immediately then still await Claude
// to pick up style_axes on "edgier" / "softer" / etc.

export function mergeSteerResults(
  fast: SteerInterpretation,
  rich: SteerInterpretation,
): SteerInterpretation {
  const union = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));
  return {
    search_terms: union(fast.search_terms, rich.search_terms),
    avoid_terms:  union(fast.avoid_terms,  rich.avoid_terms),
    price_range:  rich.price_range ?? fast.price_range,
    categories:   union(fast.categories, rich.categories),
    colors:       union(fast.colors,     rich.colors),
    style_axes:   { ...fast.style_axes, ...rich.style_axes },
    intent:       rich.intent || fast.intent,
  };
}
