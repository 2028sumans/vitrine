// ── Shared types ──────────────────────────────────────────────────────────────

export interface VisionImage {
  base64:   string;
  mimeType: string;
}
// Centralised to avoid circular imports between ai.ts and taste-memory.ts

// ── StyleDNA ──────────────────────────────────────────────────────────────────

export interface StyleReference {
  name: string;
  era:  string;
  why:  string;
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
  style_references:  StyleReference[];
  category_queries:  CategoryQueries;
  // Full-sentence FashionCLIP-optimized retrieval phrases — bypass FashionCLIP's
  // vibe-blindness by expressing the aesthetic in its native "garment + fabric +
  // color + styling" vocabulary. Used directly as text query vectors.
  retrieval_phrases?: string[];
  // Pure soft/aesthetic descriptor — vibe, mood, era, season, occasion. NO
  // brand, NO color, NO garment type, NO fabric. Used as the FashionCLIP
  // query text in stage 2 of the 2-stage retrieval (Algolia gates on the
  // hard literal terms in category_queries; FashionCLIP reranks within
  // that pool by cosine to this descriptor). Keeping it free of the
  // hard terms is what makes stage 2 actually differentiate between
  // already-filtered candidates instead of restating constants. For
  // "blue khaite dress for summer" the descriptor is just "summery,
  // breezy, unhurried" — Algolia handled the blue/Khaite/dress part.
  aesthetic_descriptor?: string;
  // 1-2 paraphrases of aesthetic_descriptor — same vibe expressed slightly
  // differently. Stage 2 encodes all of (descriptor + alts), averages and
  // L2-normalizes the resulting vectors, and uses the ensemble as the rerank
  // query. Robust to any single phrasing landing in a thin region of CLIP
  // space.
  aesthetic_descriptor_alts?: string[];
  // Concrete visual sentence — what the IDEAL product image should LOOK like:
  // silhouette + fabric + embellishment + length/cut. Complement to
  // aesthetic_descriptor (which is intentionally abstract). When the user's
  // brief is anchor-poor (just a vibe, no brand/color/garment), Stage 2
  // rerank gets fuzzy cosines because abstract phrases land in thin regions
  // of CLIP latent space. visual_signature gives FashionCLIP a sentence in
  // its native "a photo of …" vocabulary so the cosine actually concentrates.
  // Used by buildStage2QueryVector (text-mode rerank only) — Pinterest path
  // doesn't consume this field. Optional; falls back to descriptor when absent.
  // Example for "y2k party": "a tight strappy minidress in metallic or
  // rhinestone fabric with a low-rise hem and halter or one-shoulder neckline".
  visual_signature?: string;
  // 1-2 paraphrases of visual_signature — same garment described in slightly
  // different words. Stage 2 encodes all of (signature + alts), averages and
  // L2-normalizes the resulting vectors. Without alts, a single tight phrase
  // can land in a thin region of CLIP latent space and produce noisy cosines
  // that fail the visual floor / quality gate even for legitimately on-vibe
  // products. The ensemble flattens the latent-space landing zone.
  // Mirrors the same pattern as aesthetic_descriptor_alts.
  visual_signature_alts?: string[];
  // Which product categories the user's input actually centers on. Claude
  // emits this when 60%+ of the pins depict the same category (shoes board,
  // bag board, dress board). Downstream retrieval then allocates heavily to
  // these categories and keeps the others as a light complementary set —
  // a shoes board shouldn't come back as 80% dresses just because dresses
  // are more abundant in the catalog. Undefined / empty = balanced across
  // all six.
  focus_categories?: ("dress" | "top" | "bottom" | "jacket" | "shoes" | "bag")[];
  // Runtime-only — not returned by Claude, injected after DB fetch
  _boardName?: string;
}

// ── Taste memory ──────────────────────────────────────────────────────────────

export interface ClickSignal {
  object_id:   string;
  title:       string;
  brand:       string;
  color:       string;
  category:    string;
  retailer:    string;
  price_range: string;
  image_url:   string;
  clicked_at:  string;
}

export interface TasteMemory {
  previousDNAs:  StyleDNA[];
  clickSignals:  ClickSignal[];
  softAvoids:    string[];
  styleCentroid: number[] | null;  // 512-dim CLIP vector, cross-session preference
}

// ── Pre-computed product enrichment ───────────────────────────────────────────
// Written into Pinecone metadata at batch-embed time by scripts/enrich-product.mjs.
// Gives every product concrete attributes + interpretable axes that FashionCLIP
// alone cannot produce, so queries can filter/re-rank by silhouette, fabric,
// aesthetic_tag, or scalar vibe axes (formality, minimalism, edge, romance, drape).

export interface StyleAttributes {
  silhouette:     string;
  fabric:         string;
  pattern:        string;
  neckline:       string;
  length:         string;
  mood:           string;
  aesthetic_tags: string[];
}

export interface StyleAxes {
  formality:  number; // 0 = casual, 1 = black-tie
  minimalism: number; // 0 = maximalist, 1 = stripped-back
  edge:       number; // 0 = soft, 1 = subversive
  romance:    number; // 0 = tailored, 1 = flowing
  drape:      number; // 0 = structured, 1 = fluid
}

/** Flat Pinecone metadata shape — fields that search code reads back. */
export interface ProductMetadata extends StyleAttributes, StyleAxes {
  brand?:       string;
  category?:    string;
  price_range?: string;
  retailer?:    string;
  caption?:     string;
}

/** Signed deltas emitted by steer-interpret — e.g. "more minimalist" → {minimalism: +0.3}. */
export type StyleAxesDelta = Partial<Record<keyof StyleAxes, number>>;

export const STYLE_AXIS_KEYS = ["formality", "minimalism", "edge", "romance", "drape"] as const;

// ── Search input modes ────────────────────────────────────────────────────────

export type InputMode = "pinterest" | "text" | "images";
