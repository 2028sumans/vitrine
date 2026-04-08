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
  previousDNAs: StyleDNA[];
  clickSignals: ClickSignal[];
  softAvoids:   string[];
}
