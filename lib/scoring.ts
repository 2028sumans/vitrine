/**
 * TikTok-style engagement scoring for outfit cards.
 *
 * Score = P(like) × W_LIKE + P(comment) × W_COMMENT + P(click) × W_CLICK
 *
 * Predictions are heuristic (no ML model), derived from:
 *   – Click history from taste memory  (category / brand / color / price affinity)
 *   – Session liked product IDs
 *   – Dwell times   (how long user lingered on each card before swiping away)
 *   – Novelty score (inverted-U curve; slightly surprising cards = most engagement)
 *
 * Variable reward injection: every WILDCARD_INTERVAL cards, the highest-novelty
 * card from the upcoming batch is promoted forward in the queue to create the
 * "slot machine" dopamine loop that makes TikTok addictive.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

// Minimal product shape needed for scoring (all optional to accept CuratedProduct)
export interface ScoringProduct {
  objectID?:    string;
  category?:    string;
  brand?:       string;
  color?:       string;
  price_range?: string;
  retailer?:    string;
  [key: string]: unknown;
}

// Minimal card shape — loose enough to accept the concrete OutfitCard from page.tsx
export interface ScoringCard {
  id:       string;
  products: ScoringProduct[];
  liked:    boolean;
  [key: string]: unknown;
}

export interface ClickSignalLike {
  object_id?: string;
  objectID?:  string;
  category:   string;
  brand:      string;
  color:      string;
  price_range: string;
  retailer?:  string;
}

export interface ScoringSignals {
  /** Products user has explicitly liked this session */
  likedProductIds: Set<string>;
  /** Products user has clicked (from taste memory + this session) */
  clickHistory:    ClickSignalLike[];
  /** ms user spent on each card id before scrolling away */
  dwellTimes:      Record<string, number>;
  /** Expected price range from the current aesthetic */
  aestheticPrice:  string;
}

export interface CardScore {
  card:             ScoringCard;
  score:            number;
  predictedLike:    number;
  predictedComment: number;
  predictedClick:   number;
}

// ── Weights (tuned for fashion discovery) ─────────────────────────────────────
const W_LIKE    = 0.45;  // strongest — did they save/heart this?
const W_COMMENT = 0.25;  // novelty-driven — does it make them react?
const W_CLICK   = 0.30;  // intent signal — will they tap through to buy?

const WILDCARD_INTERVAL = 5; // inject a high-novelty card every N cards

// ── Affinity helpers ──────────────────────────────────────────────────────────

function categoryAffinity(category: string | undefined, history: ClickSignalLike[]): number {
  if (!category || !history.length) return 0.5;
  const hits = history.filter((c) => c.category === category).length;
  // 0 hits → 0.20, 1 hit → 0.55, 2+ → 0.80+
  return Math.min(0.95, 0.20 + hits * 0.30);
}

function brandAffinity(brand: string | undefined, history: ClickSignalLike[]): number {
  if (!brand || !history.length) return 0.30;
  const norm = brand.toLowerCase();
  return history.some((c) => c.brand?.toLowerCase() === norm) ? 0.90 : 0.30;
}

function colorAffinity(color: string | undefined, history: ClickSignalLike[]): number {
  if (!color || !history.length) return 0.50;
  const norm = color.toLowerCase();
  const hits = history.filter((c) => c.color?.toLowerCase() === norm).length;
  return Math.min(0.90, 0.30 + hits * 0.25);
}

function priceMatch(cardPrice: string | undefined, aestheticPrice: string): number {
  if (!cardPrice) return 0.60;
  if (cardPrice === aestheticPrice) return 1.00;
  if (cardPrice === "mid")          return 0.70;
  return 0.40;
}

// Average of per-product scores for a card
function avg(scores: number[]): number {
  return scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
}

// ── Dwell time → session engagement multiplier ─────────────────────────────────
// Fast-swiping (< 700 ms average) = bored session → deflate predicted scores.
// Lingering (> 3 000 ms average) = engaged session → inflate scores.

function dwellMultiplier(dwellTimes: Record<string, number>): number {
  const times = Object.values(dwellTimes);
  if (!times.length) return 1.0;
  const average = times.reduce((a, b) => a + b, 0) / times.length;
  if (average > 6000) return 1.35;
  if (average > 3000) return 1.15;
  if (average < 700)  return 0.70;
  return 1.0;
}

// ── Per-card score ────────────────────────────────────────────────────────────

export function scoreCard(card: ScoringCard, signals: ScoringSignals): CardScore {
  const { clickHistory, aestheticPrice, dwellTimes, likedProductIds } = signals;
  const products = card.products;
  const dMult    = dwellMultiplier(dwellTimes);

  // ── P(like) ────────────────────────────────────────────────────────────────
  // How well does this card match what the user has historically liked/clicked?
  const catAffinities   = products.map((p: ScoringProduct) => categoryAffinity(p.category, clickHistory));
  const colorAffinities = products.map((p: ScoringProduct) => colorAffinity(p.color,    clickHistory));
  const priceScore      = avg(products.map((p: ScoringProduct) => priceMatch(p.price_range, aestheticPrice)));
  const alreadyLiked    = products.some((p: ScoringProduct) => p.objectID != null && likedProductIds.has(p.objectID)) ? 0.05 : 0;

  const predictedLike = Math.min(0.97, (
    avg(catAffinities)   * 0.40 +
    avg(colorAffinities) * 0.25 +
    priceScore           * 0.20 +
    0.10                         // base engagement rate
  ) * dMult + alreadyLiked);

  // ── P(comment / say-more) ─────────────────────────────────────────────────
  // Novelty drives "say more" interactions — cards that are slightly outside
  // the user's usual repertoire provoke the most direction-giving feedback.
  // Inverted-U: too familiar → low reaction, too alien → confusion, sweet spot 0.35–0.65.
  const clickedCats = new Set(clickHistory.slice(0, 10).map((c: ClickSignalLike) => c.category));
  const novelCount  = products.filter((p: ScoringProduct) => p.category && !clickedCats.has(p.category)).length;
  const novelty     = novelCount / Math.max(1, products.length); // 0–1

  let predictedComment: number;
  if      (novelty < 0.25) predictedComment = 0.15 + novelty * 1.20; // too familiar
  else if (novelty < 0.65) predictedComment = 0.50 + (novelty - 0.25) * 0.60; // sweet spot
  else                     predictedComment = 0.50 - (novelty - 0.65) * 0.80; // too alien
  predictedComment = Math.max(0.05, Math.min(0.90, predictedComment));

  // ── P(click) ───────────────────────────────────────────────────────────────
  // Probability the user taps a product and visits the retailer.
  // Brand recognition is the strongest driver after category interest.
  const brandAffinities = products.map((p: ScoringProduct) => brandAffinity(p.brand, clickHistory));

  const predictedClick = Math.min(0.95,
    avg(catAffinities)   * 0.35 +
    avg(brandAffinities) * 0.35 +
    priceScore           * 0.20 +
    0.10                         // base click-through rate
  );

  // Freshness bonus: products scraped in the last 7 days get a small boost
  // This ensures new inventory surfaces even if it doesn't match click history yet
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const isNewProduct = (p: ScoringProduct) => {
    const sa = (p as { scraped_at?: string }).scraped_at;
    return sa && (Date.now() - new Date(sa).getTime()) < SEVEN_DAYS_MS;
  };
  const hasNewProducts = products.some(isNewProduct);
  const freshnessBonus = hasNewProducts ? 0.06 : 0;

  const score =
    predictedLike    * W_LIKE    +
    predictedComment * W_COMMENT +
    predictedClick   * W_CLICK   +
    freshnessBonus;

  return { card, score, predictedLike, predictedComment, predictedClick };
}

// ── Rank + variable-reward injection ─────────────────────────────────────────
//
// 1. Sort cards by composite score (high → low).
// 2. Every WILDCARD_INTERVAL positions, swap in the highest-novelty card from
//    the rest of the queue.  This creates the slot-machine effect: mostly great
//    content, but occasional surprises keep users scrolling for the next hit.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rankCards(cards: any[], signals: ScoringSignals): any[] {
  if (cards.length <= 1) return cards;

  const scored = cards.map((card) => ({ ...scoreCard(card, signals), card }));
  scored.sort((a, b) => b.score - a.score);

  // Wildcard injection
  for (let pos = WILDCARD_INTERVAL - 1; pos < scored.length; pos += WILDCARD_INTERVAL) {
    const searchFrom = pos + 1;
    if (searchFrom >= scored.length) break;
    let wildcardIdx = searchFrom;
    for (let i = searchFrom + 1; i < scored.length; i++) {
      if (scored[i].predictedComment > scored[wildcardIdx].predictedComment) wildcardIdx = i;
    }
    if (wildcardIdx !== searchFrom) {
      const [wildcard] = scored.splice(wildcardIdx, 1);
      scored.splice(pos, 0, wildcard);
    }
  }

  return scored.map((s) => s.card);
}

// ── Dwell signal classification ───────────────────────────────────────────────
// Used by the page to decide whether a re-ranking pass is worth triggering.

export type DwellSignal = "strong_positive" | "positive" | "neutral" | "negative";

export function interpretDwell(ms: number): DwellSignal {
  if (ms > 7000) return "strong_positive"; // lingered > 7s — very interested
  if (ms > 2500) return "positive";        // normal engaged viewing
  if (ms > 700)  return "neutral";         // scrolled past normally
  return "negative";                       // fast swipe — not interested
}

// ── Re-rank the upcoming portion of the queue ────────────────────────────────
// Call this after a strong signal (like, strong dwell, consecutive fast swipes)
// to re-order only the cards the user hasn't seen yet.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reRankUpcoming(
  allCards:   any[],
  currentIdx: number,
  signals:    ScoringSignals,
): any[] {
  const seen     = allCards.slice(0, currentIdx + 1);
  const upcoming = allCards.slice(currentIdx + 1);
  if (upcoming.length <= 1) return allCards;
  return [...seen, ...rankCards(upcoming, signals)];
}
