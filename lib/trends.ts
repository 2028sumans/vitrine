// ── Pinterest Trends ──────────────────────────────────────────────────────────
// Fetches top growing trends and filters to ones relevant to a given StyleDNA.
// Used to ground Claude's commentary in what's actually trending right now.

import type { StyleDNA } from "@/lib/types";

export interface TrendSignal {
  keyword:       string;
  pct_growth_wow: number;
  pct_growth_mom: number;
}

// Fetch top N growing trends from Pinterest Trends API
async function fetchGrowingTrends(limit = 50): Promise<TrendSignal[]> {
  const token = process.env.PINTEREST_ACCESS_TOKEN;
  if (!token) return [];

  try {
    const res = await fetch(
      `https://api.pinterest.com/v5/trends/keywords/US/top/growing?limit=${limit}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        next: { revalidate: 3600 }, // cache for 1 hour — data is daily anyway
      }
    );

    if (!res.ok) {
      console.warn("Pinterest Trends API error:", res.status);
      return [];
    }

    const data = await res.json();
    return (data.trends ?? []) as TrendSignal[];
  } catch (err) {
    console.warn("Pinterest Trends fetch failed (non-fatal):", err);
    return [];
  }
}

// Score a trend keyword's relevance to the StyleDNA
function relevanceScore(keyword: string, dna: StyleDNA): number {
  const words = keyword.toLowerCase().split(/\s+/);

  // Build a bag of words from the DNA
  const dnaText = [
    dna.primary_aesthetic,
    dna.secondary_aesthetic ?? "",
    ...(dna.style_keywords ?? []),
    ...(dna.key_pieces ?? []),
    ...(dna.color_palette ?? []),
    ...(dna.silhouettes ?? []),
    dna.mood ?? "",
  ]
    .join(" ")
    .toLowerCase();

  // Count how many trend words appear in the DNA text
  let score = 0;
  for (const w of words) {
    if (w.length > 3 && dnaText.includes(w)) score += 1;
  }

  // Boost score by growth momentum
  return score;
}

// Returns the top relevant trending signals for this StyleDNA
export async function getRelevantTrends(
  dna: StyleDNA,
  maxResults = 6
): Promise<TrendSignal[]> {
  const allTrends = await fetchGrowingTrends(50);
  if (!allTrends.length) return [];

  // Score and filter to relevant trends
  const scored = allTrends
    .map((t) => ({ trend: t, score: relevanceScore(t.keyword, dna) }))
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score || b.trend.pct_growth_mom - a.trend.pct_growth_mom);

  // If nothing matches the DNA, return top growers by mom growth anyway
  if (!scored.length) {
    return allTrends
      .sort((a, b) => b.pct_growth_mom - a.pct_growth_mom)
      .slice(0, 3);
  }

  return scored.slice(0, maxResults).map((s) => s.trend);
}

// Formats trends into a text block for Claude prompts
export function formatTrendsBlock(trends: TrendSignal[]): string {
  if (!trends.length) return "";

  const lines = trends.map((t) => {
    const mom = t.pct_growth_mom > 0 ? `+${t.pct_growth_mom}% this month` : "";
    const wow = t.pct_growth_wow > 0 ? `+${t.pct_growth_wow}% this week` : "";
    const growth = [mom, wow].filter(Boolean).join(", ");
    return `  • "${t.keyword}"${growth ? ` — ${growth}` : ""}`;
  });

  return (
    `TRENDING NOW ON PINTEREST — keywords with real search momentum right now:\n` +
    lines.join("\n") +
    `\n\nWhere relevant, weave these trends naturally into your commentary. ` +
    `A brief mention ("this silhouette is having a major moment") makes the edit feel current. ` +
    `Don't force it — only reference trends that genuinely connect to the selected pieces.`
  );
}
