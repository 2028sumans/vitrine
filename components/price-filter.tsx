"use client";

import { useMemo } from "react";

/**
 * Shared price-tier filter used on the three shopping surfaces — /shop
 * category mode, /shop brand mode, and /dashboard tailored grid.
 *
 * Philosophy: apply client-side over the already-loaded product set. The
 * server has no idea we're filtering; /shop-all pagination keeps pulling the
 * same unfiltered biased feed, and we just hide anything that doesn't match
 * the selected tier until the user relaxes the filter. Fast, reversible,
 * zero extra API cost.
 *
 * Tiers map to the numeric `price` field first (most accurate), with a
 * fallback to the categorical `price_range` string ("budget" | "mid" | "luxury")
 * on records that don't have a price set — Vintage/resale scrapers often lack
 * a concrete number. Records with NEITHER field remain visible under every
 * filter so we don't silently drop them from the feed.
 */

export type PriceTier = "all" | "under100" | "100to300" | "300to1000" | "over1000";

export const PRICE_TIER_LABELS: Array<{ tier: PriceTier; label: string }> = [
  { tier: "all",        label: "All"           },
  { tier: "under100",   label: "Under $100"    },
  { tier: "100to300",   label: "$100 – $300"   },
  { tier: "300to1000",  label: "$300 – $1,000" },
  { tier: "over1000",   label: "$1,000+"       },
];

// A product-ish shape — any object with (optional) price + price_range fields.
interface Pricey {
  price?:       number | null;
  price_range?: string;
}

/** True when the product passes the selected tier. */
export function matchesPriceTier(p: Pricey, tier: PriceTier): boolean {
  if (tier === "all") return true;

  const price = typeof p.price === "number" ? p.price : null;
  if (price != null) {
    if (tier === "under100")  return price < 100;
    if (tier === "100to300")  return price >= 100  && price < 300;
    if (tier === "300to1000") return price >= 300  && price < 1000;
    if (tier === "over1000")  return price >= 1000;
  }

  // Fallback when no numeric price — use the coarser price_range tier. Map:
  //   budget → Under $100
  //   mid    → $100–$300
  //   luxury → $300–$1000 or $1000+  (bias luxury into the 300–1000 bucket,
  //            but also allow $1000+ selection to keep it since we can't
  //            distinguish high-end from hyper-lux without a number)
  const pr = (p.price_range ?? "").toLowerCase();
  if (!pr) return true;
  if (tier === "under100")  return pr === "budget";
  if (tier === "100to300")  return pr === "mid";
  if (tier === "300to1000") return pr === "luxury";
  if (tier === "over1000")  return pr === "luxury";
  return true;
}

/** Convenience hook — derives the filtered list with useMemo. */
export function useFilteredByPrice<T extends Pricey>(list: T[], tier: PriceTier): T[] {
  return useMemo(
    () => (tier === "all" ? list : list.filter((p) => matchesPriceTier(p, tier))),
    [list, tier],
  );
}

// ── UI ────────────────────────────────────────────────────────────────────────

interface Props {
  tier:     PriceTier;
  onChange: (next: PriceTier) => void;
  /** Optional — shown as small grey text next to the pills, e.g. "92 shown". */
  count?:   number;
  /** Optional className — lets consumers control the surrounding margin/border. */
  className?: string;
}

export function PriceFilterBar({ tier, onChange, count, className }: Props) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 ${className ?? ""}`}>
      <div
        className="flex flex-wrap gap-1.5"
        role="radiogroup"
        aria-label="Filter by price"
      >
        {PRICE_TIER_LABELS.map(({ tier: t, label }) => {
          const active = t === tier;
          return (
            <button
              key={t}
              role="radio"
              aria-checked={active}
              onClick={() => onChange(t)}
              className={
                "px-3.5 py-1.5 font-sans text-[10px] tracking-widest uppercase border transition-colors duration-150 " +
                (active
                  ? "bg-foreground text-background border-foreground"
                  : "border-border-mid text-muted hover:text-foreground hover:border-foreground/60")
              }
            >
              {label}
            </button>
          );
        })}
      </div>
      {count != null && (
        <span className="font-sans text-[10px] tracking-widest uppercase text-muted">
          {count.toLocaleString()} shown
        </span>
      )}
    </div>
  );
}
