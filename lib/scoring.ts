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
  /** Products from cards the user scrolled past very fast (<700ms). Used to
   *  penalize upcoming cards sharing category/brand/color with the dislikes. */
  dislikedSignals: ClickSignalLike[];
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
// Bumped W_LIKE up and W_COMMENT down after session feedback that likes and
// saves felt too subtle — a user expressing an explicit preference wants the
// next 2-3 cards to reflect it, not a weak lean over the next 10. The
// novelty/comment signal still ships (for the wildcard-injection path that
// keeps the feed from tunneling) but its weight on primary ranking drops.
const W_LIKE    = 0.55;  // strongest — explicit preference signal
const W_COMMENT = 0.15;  // novelty nudge — still feeds wildcards
const W_CLICK   = 0.30;  // intent signal — will they tap through to buy?

// How much more weight to give RECENT hits in click history vs older ones.
// The 3 most-recent entries each count as `RECENCY_WEIGHT` hits so "I just
// liked 3 Khaite pieces" overwhelms "I clicked one Reformation 20 cards ago."
// clickHistoryRef is maintained newest-first on the shop page.
const RECENCY_WINDOW = 3;
const RECENCY_WEIGHT = 2;

// Default wildcard cadence. Used as the baseline for adaptive tuning in
// `rankCards`: a hot-streak session exploits more (sparser wildcards) and a
// cold / skipping session explores more (denser wildcards).
const WILDCARD_INTERVAL_BASE = 5;
const WILDCARD_INTERVAL_MIN  = 3;   // high-exploration floor
const WILDCARD_INTERVAL_MAX  = 9;   // high-exploitation ceiling

// ── Affinity helpers ──────────────────────────────────────────────────────────

// Count hits in history where `match(entry)` is true, with the first
// RECENCY_WINDOW entries weighted RECENCY_WEIGHT× so a fresh cluster of
// likes dominates older history. History is maintained newest-first, so
// `slice(0, RECENCY_WINDOW)` is the hot cluster.
function weightedHits(
  history: ClickSignalLike[],
  match: (entry: ClickSignalLike) => boolean,
): number {
  let n = 0;
  for (let i = 0; i < history.length; i++) {
    if (!match(history[i])) continue;
    n += i < RECENCY_WINDOW ? RECENCY_WEIGHT : 1;
  }
  return n;
}

function categoryAffinity(category: string | undefined, history: ClickSignalLike[]): number {
  if (!category || !history.length) return 0.5;
  const hits = weightedHits(history, (c) => c.category === category);
  // 0 hits → 0.20, 1 hit → 0.60, 2 → 0.85, 3+ → 0.98. Steeper than before:
  // an explicit preference now lands a liked-category card at ~0.98 affinity
  // instead of ~0.80 after the same two hits.
  return Math.min(0.98, 0.20 + hits * 0.38);
}

function brandAffinity(brand: string | undefined, history: ClickSignalLike[]): number {
  if (!brand || !history.length) return 0.30;
  const norm = brand.toLowerCase();
  const hits = weightedHits(history, (c) => c.brand?.toLowerCase() === norm);
  // Was binary (any hit = 0.90). Now multi-hit stacks: a user who's liked
  // 3 Khaite pieces should see Khaite cards rank harder than a user who
  // liked one. 0.40 base if unseen (slight downweight vs old 0.30 since
  // hits now reach higher).
  if (hits === 0) return 0.40;
  return Math.min(0.98, 0.75 + (hits - 1) * 0.12);
}

function colorAffinity(color: string | undefined, history: ClickSignalLike[]): number {
  if (!color || !history.length) return 0.50;
  const norm = color.toLowerCase();
  const hits = weightedHits(history, (c) => c.color?.toLowerCase() === norm);
  // 0 → 0.30, 1 → 0.65, 2 → 0.85, 3+ → 0.95
  return Math.min(0.95, 0.30 + hits * 0.32);
}

// ── Dislike penalties (mirror of affinities, behavioral-asymmetry tuned) ─────
// People's aversion is reliably stronger than their approach motivation, so
// per-hit penalties are slightly stronger than the equivalent positive nudges.

function categoryPenalty(category: string | undefined, disliked: ClickSignalLike[]): number {
  if (!category || !disliked.length) return 0;
  const hits = disliked.filter((c) => c.category === category).length;
  // 1 hit → 0.18, 2 → 0.32, 3+ → 0.42
  return Math.min(0.45, hits * 0.16);
}

function brandPenalty(brand: string | undefined, disliked: ClickSignalLike[]): number {
  if (!brand || !disliked.length) return 0;
  const norm = brand.toLowerCase();
  // Any hit on same brand is a strong signal ("I saw this brand and scrolled fast")
  const hits = disliked.filter((c) => c.brand?.toLowerCase() === norm).length;
  return hits === 0 ? 0 : Math.min(0.55, 0.30 + (hits - 1) * 0.15);
}

function colorPenalty(color: string | undefined, disliked: ClickSignalLike[]): number {
  if (!color || !disliked.length) return 0;
  const norm = color.toLowerCase();
  const hits = disliked.filter((c) => c.color?.toLowerCase() === norm).length;
  return Math.min(0.40, hits * 0.14);
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
// Continuous version. Averages `dwellScore(ms)` across the session and maps
// the mean to a multiplier in [0.70, 1.35]. Low engagement (fast swipes all
// session) pulls predicted scores down; high engagement pulls them up.

function dwellMultiplier(dwellTimes: Record<string, number>): number {
  const times = Object.values(dwellTimes);
  if (!times.length) return 1.0;
  const meanScore = times.reduce((a, ms) => a + dwellScore(ms), 0) / times.length;
  // meanScore ∈ [0, 1]; map to [0.70, 1.35] linearly.
  return 0.70 + meanScore * 0.65;
}

// ── Per-card score ────────────────────────────────────────────────────────────

export function scoreCard(card: ScoringCard, signals: ScoringSignals): CardScore {
  const { clickHistory, dislikedSignals = [], aestheticPrice, dwellTimes, likedProductIds } = signals;
  const products = card.products;
  const dMult    = dwellMultiplier(dwellTimes);

  // ── P(like) ────────────────────────────────────────────────────────────────
  // How well does this card match what the user has historically liked/clicked?
  const catAffinities   = products.map((p: ScoringProduct) => categoryAffinity(p.category, clickHistory));
  const colorAffinities = products.map((p: ScoringProduct) => colorAffinity(p.color,    clickHistory));
  // Brand affinity now also feeds predictedLike (previously only predictedClick).
  // A user who's liked Khaite 3× should see NEW Khaite pieces lift in like-probability,
  // not just click-probability. The click formula keeps its own brand slot below.
  const brandAffinitiesForLike = products.map((p: ScoringProduct) => brandAffinity(p.brand, clickHistory));
  const priceScore      = avg(products.map((p: ScoringProduct) => priceMatch(p.price_range, aestheticPrice)));
  const alreadyLiked    = products.some((p: ScoringProduct) => p.objectID != null && likedProductIds.has(p.objectID)) ? 0.10 : 0;

  // Dislike penalties — if any of this card's products share attributes with
  // fast-swiped-past cards, push its score down. Worst attribute wins per card
  // so one matching strong signal drags the whole card.
  const catPenalties   = products.map((p: ScoringProduct) => categoryPenalty(p.category, dislikedSignals));
  const colorPenalties = products.map((p: ScoringProduct) => colorPenalty(p.color,    dislikedSignals));

  const predictedLike = Math.max(0.02, Math.min(0.97, (
    avg(catAffinities)           * 0.38 +
    avg(brandAffinitiesForLike)  * 0.22 +   // new: brand affinity contributes to like
    avg(colorAffinities)         * 0.20 +
    priceScore                   * 0.15 +
    0.05                                    // base engagement rate (was 0.10 — brand now carries that mass)
  ) * dMult + alreadyLiked
    - Math.max(...catPenalties)   * 0.50   // the most-disliked category in the card
    - Math.max(...colorPenalties) * 0.30)); // the most-disliked color in the card

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
  // Brand recognition is the strongest driver after category interest — and,
  // in the negative direction, brand recoil is the strongest repellent.
  const brandAffinities = products.map((p: ScoringProduct) => brandAffinity(p.brand, clickHistory));
  const brandPenalties  = products.map((p: ScoringProduct) => brandPenalty(p.brand, dislikedSignals));

  const predictedClick = Math.max(0.02, Math.min(0.95,
    avg(catAffinities)   * 0.35 +
    avg(brandAffinities) * 0.35 +
    priceScore           * 0.20 +
    0.10                         // base click-through rate
    - Math.max(...brandPenalties) * 0.55     // strongest repellent
    - Math.max(...catPenalties)   * 0.35));

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
// 3. The interval is ADAPTIVE — strong recent signal (high dwell, lots of
//    likes) narrows exploration; a cold/skipping session widens it.
//    A user who's liking everything doesn't need random injections to find
//    their taste; a user skipping everything needs more variety to discover it.

/** Exploration ratio ∈ [0, 1] derived from session signals. 0 = pure exploit
 *  (sparse wildcards), 1 = pure explore (dense wildcards). Heuristic rather
 *  than learned — tunable and transparent. */
function exploreRatio(signals: ScoringSignals): number {
  const { likedProductIds, dislikedSignals, dwellTimes } = signals;
  const likes   = likedProductIds.size;
  const dislikes = dislikedSignals.length;
  const total   = Object.keys(dwellTimes).length;

  // Cold start: nothing to go on yet → lean toward exploration.
  if (total < 3) return 0.75;

  // Mean dwell score across the session.
  const meanDwell = Object.values(dwellTimes)
    .reduce((a, ms) => a + dwellScore(ms), 0) / Math.max(1, total);

  // Three signals, each pushes toward explore when weak:
  //   low like-rate, high dislike-rate, low mean dwell.
  const likeRate    = likes / total;                    // 0..1
  const dislikeRate = dislikes / Math.max(1, total);    // 0..1 (capped)

  // Blend: weights chosen to make dwell the dominant signal (it captures
  // boredom better than sparse likes), with like/dislike rate as correctives.
  const engagement = 0.60 * meanDwell + 0.25 * likeRate - 0.35 * Math.min(1, dislikeRate);

  // High engagement → low explore. Clamp to [0.15, 0.75] so we never go all
  // the way to either extreme — some variety always, some relevance always.
  return Math.min(0.75, Math.max(0.15, 0.75 - engagement));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rankCards(cards: any[], signals: ScoringSignals): any[] {
  if (cards.length <= 1) return cards;

  const scored = cards.map((card) => ({ ...scoreCard(card, signals), card }));
  scored.sort((a, b) => b.score - a.score);

  // Translate explore ratio to wildcard spacing. ratio=0 → MAX (9 apart, very
  // sparse), ratio=1 → MIN (3 apart, very dense). Linear interpolation.
  const ratio    = exploreRatio(signals);
  const interval = Math.round(
    WILDCARD_INTERVAL_MAX - ratio * (WILDCARD_INTERVAL_MAX - WILDCARD_INTERVAL_MIN)
  );
  const stride = Math.max(WILDCARD_INTERVAL_MIN, Math.min(WILDCARD_INTERVAL_MAX, interval));

  // Wildcard injection at the adapted cadence.
  void WILDCARD_INTERVAL_BASE; // documented baseline; stride is derived.
  for (let pos = stride - 1; pos < scored.length; pos += stride) {
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

// ── Dwell signal — continuous score + bucket view ────────────────────────────
// Previously we collapsed dwell into 4 discrete buckets. A 3-second dwell and
// a 6.9-second dwell were both "positive" — lots of information lost. Now the
// primary interface is `dwellScore(ms) ∈ [0, 1]`, a log-scaled continuous
// signal: 500 ms → 0, 8 s → 1, smoothly in between. The bucket classifier is
// kept for callers that still want a hard label (e.g. "fire a negative-signal
// refetch on fast swipes") but new code should consume the continuous score.

export type DwellSignal = "strong_positive" | "positive" | "neutral" | "negative";

/** Continuous [0, 1] score for how engaged a dwell reads as.
 *  500 ms → 0 (fast swipe), 8 s → 1 (locked in), log-scaled in between. */
export function dwellScore(ms: number): number {
  if (ms <= 500)  return 0;
  if (ms >= 8000) return 1;
  // log-scale so the interesting range (1–5s) gets most of the resolution
  // rather than being crushed by the tail.
  return Math.log(ms / 500) / Math.log(8000 / 500);
}

/** Legacy bucket view. Keep for code paths that branch on labels; new code
 *  should prefer `dwellScore`. Thresholds align roughly with the old ones. */
export function interpretDwell(ms: number): DwellSignal {
  if (ms > 7000) return "strong_positive";
  if (ms > 2500) return "positive";
  if (ms > 700)  return "neutral";
  return "negative";
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
