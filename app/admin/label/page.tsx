"use client";

/**
 * /admin/label — Gold eval-set labeling tool.
 *
 * One-shot internal tool for building the hand-labeled aesthetic eval set that
 * feeds into scripts/train-taste-head.mjs (and eventually the Bradley-Terry
 * preference head + LoRA fine-tune).
 *
 * Workflow
 * --------
 *   1. Pick an aesthetic pill under each product tile — one label per product.
 *   2. Progress counters at top show X/TARGET per aesthetic.
 *   3. Labels auto-save to localStorage on every click, so a tab close /
 *      refresh is safe.
 *   4. When you've hit ~40 per aesthetic, hit "Download JSON" — that file
 *      lands in ~/Downloads as `eval-labels-<ts>.json`. Move it to
 *      `data/eval-labels.json` and run `scripts/build-eval-triplets.mjs`.
 *
 * Product source
 * --------------
 *   We hit the same /api/shop-all endpoint the shop page uses. An optional
 *   category filter narrows the pool (browse Tops separately from Dresses
 *   so the eyeball can stay in one silhouette at a time). No signals /
 *   bias — we want the raw inventory, not a personalized view.
 *
 * Design
 * ------
 *   Functional over pretty. Cream background + olive text to match the site
 *   so it's not jarring, but no animations, no scroll effects. Labels win
 *   over style; this is a 2-hour internal tool.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

// ── Config ────────────────────────────────────────────────────────────────────

interface Aesthetic {
  /** Stable key written into the exported JSON. */
  key:   string;
  /** Display label on the pill. Short — pills are crowded. */
  label: string;
  /** Tailwind color class applied to the tagged-tile border + active pill bg. */
  tint:  string;
}

/**
 * Age-range taxonomy for the golden eval set.
 *
 * Each label on an item reads as "this piece represents what someone in this
 * age range typically likes" — demographic taste centroid, not a hard gate.
 * The bucket centroids become the first-touch taste prior for new users whose
 * quiz answer lands them in the same bucket.
 *
 * Keep `key` stable once you've started labeling (changing a key orphans all
 * previously-labeled items). Labels / tints are cosmetic.
 */
const AESTHETICS: readonly Aesthetic[] = [
  { key: "age-13-18", label: "13–18", tint: "border-[#3a8aaa] bg-[#3a8aaa] text-[#FAFAF5]" },
  { key: "age-18-25", label: "18–25", tint: "border-[#6a2a3a] bg-[#6a2a3a] text-[#FAFAF5]" },
  { key: "age-25-32", label: "25–32", tint: "border-[#2A3316] bg-[#2A3316] text-[#FAFAF5]" },
  { key: "age-32-40", label: "32–40", tint: "border-[#8a6a4a] bg-[#8a6a4a] text-[#FAFAF5]" },
  { key: "age-40-60", label: "40–60", tint: "border-[#1a2a4a] bg-[#1a2a4a] text-[#FAFAF5]" },
];

/** Target items per aesthetic. Progress bar fills to this. */
const TARGET_PER_AESTHETIC = 40;

/** localStorage key. Bump the version suffix if the schema below changes. */
const STORAGE_KEY = "muse-eval-labels-v1";

/** Category filter options. null = no filter. Mirror shop category scopes. */
const CATEGORY_OPTIONS: ReadonlyArray<{ label: string; value: string | null }> = [
  { label: "All",                   value: null },
  { label: "Tops",                  value: "Tops" },
  { label: "Dresses",               value: "Dresses" },
  { label: "Bottoms",               value: "Bottoms" },
  { label: "Knits",                 value: "Knits" },
  { label: "Outerwear",             value: "Outerwear" },
  { label: "Shoes",                 value: "Shoes" },
  { label: "Bags and accessories", value: "Bags and accessories" },
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface Product {
  objectID:   string;
  title:      string;
  brand:      string;
  image_url:  string;
  category?:  string;
}

interface LabelStore {
  version:   number;
  /** objectID → aesthetic key. One aesthetic per product (single-label). */
  labels:    Record<string, string>;
  /** Product metadata we've seen, so the export includes title/brand/image. */
  products:  Record<string, { title: string; brand: string; image_url: string; category?: string }>;
  updatedAt: string;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function emptyStore(): LabelStore {
  return { version: 1, labels: {}, products: {}, updatedAt: new Date().toISOString() };
}

function loadStore(): LabelStore {
  if (typeof window === "undefined") return emptyStore();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.labels && parsed.products) {
      return parsed as LabelStore;
    }
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

function saveStore(store: LabelStore) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LabelPage() {
  const [store, setStore]           = useState<LabelStore>(emptyStore);
  const [products, setProducts]     = useState<Product[]>([]);
  const [page, setPage]             = useState(0);
  const [loading, setLoading]       = useState(false);
  const [hasMore, setHasMore]       = useState(true);
  const [category, setCategory]     = useState<string | null>(null);
  const [hideTagged, setHideTagged] = useState(false);
  const seenIdsRef                  = useRef<Set<string>>(new Set());

  // Hydrate from localStorage on mount. We intentionally *do not* save back
  // in this effect — that would wipe existing data if the parse failed.
  useEffect(() => {
    setStore(loadStore());
  }, []);

  // Reset product list when category changes (scope flip = fresh fetch).
  useEffect(() => {
    setProducts([]);
    setPage(0);
    setHasMore(true);
    seenIdsRef.current = new Set();
  }, [category]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const res = await fetch("/api/shop-all", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          page,
          categoryFilter: category ?? "",
          brandFilter:    "",
          // No session signals — we want the raw catalog.
          bias:            {},
          likedProductIds: [],
          steerQuery:      "",
          steerInterp:     null,
        }),
      });
      if (!res.ok) { setHasMore(false); return; }
      const data = await res.json();
      const fresh = (data.products ?? []) as Product[];
      const seen = seenIdsRef.current;
      const batch: Product[] = [];
      for (const p of fresh) {
        if (!p.objectID || seen.has(p.objectID)) continue;
        seen.add(p.objectID);
        batch.push(p);
      }
      setProducts((prev) => [...prev, ...batch]);
      setPage((p) => p + 1);
      if (!data.hasMore) setHasMore(false);
    } catch (err) {
      console.error("[label] load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [page, loading, hasMore, category]);

  // Kick off initial load when products list is empty and we think there's more.
  useEffect(() => {
    if (products.length === 0 && hasMore && !loading) {
      void loadMore();
    }
  }, [products.length, hasMore, loading, loadMore]);

  // Tag / untag a product with an aesthetic.
  // Clicking the already-active pill untags. Clicking another pill retags.
  const toggleLabel = useCallback((product: Product, aestheticKey: string) => {
    setStore((prev) => {
      const next: LabelStore = {
        ...prev,
        labels:   { ...prev.labels },
        products: { ...prev.products },
      };
      const current = next.labels[product.objectID];
      if (current === aestheticKey) {
        delete next.labels[product.objectID];
      } else {
        next.labels[product.objectID] = aestheticKey;
        next.products[product.objectID] = {
          title:     product.title,
          brand:     product.brand,
          image_url: product.image_url,
          category:  product.category,
        };
      }
      next.updatedAt = new Date().toISOString();
      saveStore(next);
      return next;
    });
  }, []);

  // Counts per aesthetic for the progress bars.
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of AESTHETICS) m[a.key] = 0;
    for (const k of Object.values(store.labels)) {
      if (m[k] != null) m[k]++;
    }
    return m;
  }, [store.labels]);

  // Total = labels whose aesthetic is still in the current taxonomy. If you
  // rename / remove an aesthetic (changing its `key`), previously-tagged items
  // stay in localStorage but don't count here — avoids a misleading "2/200"
  // where one of those 2 is actually orphaned. Orphan labels are dropped on
  // export by the converter too (it only groups by whatever keys it finds in
  // the labels map, so orphaned keys become their own no-downstream-effect
  // group — still worth filtering here for UI honesty).
  const activeKeys = useMemo(() => new Set(AESTHETICS.map((a) => a.key)), []);
  const total      = Object.values(store.labels).filter((k) => activeKeys.has(k)).length;
  const target     = AESTHETICS.length * TARGET_PER_AESTHETIC;

  // Optionally filter out already-tagged tiles so the user can focus on fresh
  // inventory once a run is underway.
  const visibleProducts = useMemo(
    () => (hideTagged ? products.filter((p) => !store.labels[p.objectID]) : products),
    [products, hideTagged, store.labels],
  );

  // Export current store to a JSON file the user can drop into
  // `data/eval-labels.json` for the converter script.
  const downloadJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const ts   = new Date().toISOString().replace(/[:.]/g, "-");
    a.href     = url;
    a.download = `eval-labels-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [store]);

  const resetAll = useCallback(() => {
    if (!confirm("Wipe ALL labels from localStorage? This can't be undone.")) return;
    const fresh = emptyStore();
    setStore(fresh);
    saveStore(fresh);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header — sticky so progress stays visible while scrolling the grid. */}
      <header className="sticky top-0 z-40 bg-background/95 backdrop-blur-sm border-b border-border-mid">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-5">
              <Link href="/" className="font-display font-light text-base tracking-[0.22em] text-foreground">
                MUSE
              </Link>
              <span className="font-sans text-[9px] tracking-widest uppercase text-muted">
                Admin · label eval set
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-sans text-[10px] tracking-widest uppercase text-muted-strong">
                {total}/{target}
              </span>
              <button
                onClick={downloadJson}
                disabled={total === 0}
                className="px-4 py-2 font-sans text-[10px] tracking-widest uppercase border border-foreground text-foreground hover:bg-foreground hover:text-background transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ↓ Download JSON
              </button>
              <button
                onClick={resetAll}
                className="px-4 py-2 font-sans text-[10px] tracking-widest uppercase border border-border-mid text-muted hover:text-foreground hover:border-foreground transition-colors"
              >
                Reset
              </button>
            </div>
          </div>

          {/* Aesthetic counters */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {AESTHETICS.map((a) => {
              const n   = counts[a.key] ?? 0;
              const pct = Math.min(100, (n / TARGET_PER_AESTHETIC) * 100);
              const done = n >= TARGET_PER_AESTHETIC;
              return (
                <div key={a.key} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between">
                    <span className="font-sans text-[10px] tracking-widest uppercase text-muted-strong">
                      {a.label}
                    </span>
                    <span className={`font-sans text-[10px] tracking-widest uppercase tabular-nums ${done ? "text-accent" : "text-muted"}`}>
                      {n}/{TARGET_PER_AESTHETIC}
                    </span>
                  </div>
                  <div className="h-0.5 bg-border w-full">
                    <div
                      className="h-full bg-foreground transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </header>

      {/* Controls — category filter + hide-tagged toggle */}
      <div className="max-w-7xl mx-auto px-6 py-5 flex flex-wrap items-center gap-3 border-b border-border">
        <span className="font-sans text-[9px] tracking-widest uppercase text-muted-dim mr-1">
          Category
        </span>
        {CATEGORY_OPTIONS.map((c) => {
          const active = category === c.value;
          return (
            <button
              key={c.label}
              onClick={() => setCategory(c.value)}
              className={`px-3 py-1.5 font-sans text-[10px] tracking-widest uppercase border transition-colors ${
                active
                  ? "bg-foreground text-background border-foreground"
                  : "border-border-mid text-muted hover:text-foreground hover:border-foreground/60"
              }`}
            >
              {c.label}
            </button>
          );
        })}

        <div className="flex-1" />

        <label className="flex items-center gap-2 font-sans text-[10px] tracking-widest uppercase text-muted-strong cursor-pointer">
          <input
            type="checkbox"
            checked={hideTagged}
            onChange={(e) => setHideTagged(e.target.checked)}
            className="accent-foreground"
          />
          Hide tagged
        </label>
      </div>

      {/* Product grid */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {products.length === 0 && loading && (
          <p className="font-display italic text-xl text-muted text-center py-24">
            Loading inventory…
          </p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {visibleProducts.map((p) => {
            const tagged = store.labels[p.objectID];
            const aesthetic = AESTHETICS.find((a) => a.key === tagged);
            return (
              <div
                key={p.objectID}
                className={`flex flex-col border-2 transition-colors ${
                  aesthetic ? aesthetic.tint.split(" ")[0] : "border-transparent"
                }`}
              >
                {/* Image */}
                <div className="aspect-[3/4] bg-[rgba(42,51,22,0.04)] overflow-hidden">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.image_url}
                    alt={p.title}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                </div>

                {/* Title / brand */}
                <div className="px-1 pt-2">
                  <p className="font-sans text-[9px] tracking-widest uppercase text-muted truncate">
                    {p.brand}
                  </p>
                  <p className="font-sans text-xs text-foreground leading-tight line-clamp-2 mb-2">
                    {p.title}
                  </p>
                </div>

                {/* Aesthetic pills */}
                <div className="flex flex-wrap gap-1 p-1">
                  {AESTHETICS.map((a) => {
                    const active = tagged === a.key;
                    return (
                      <button
                        key={a.key}
                        onClick={() => toggleLabel(p, a.key)}
                        title={a.label}
                        className={`flex-1 min-w-0 px-1.5 py-1 font-sans text-[9px] tracking-widest uppercase border transition-colors truncate ${
                          active
                            ? a.tint
                            : "border-border-mid text-muted hover:text-foreground hover:border-foreground/60"
                        }`}
                      >
                        {a.label.split(" ")[0]}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Load more */}
        <div className="flex items-center justify-center py-10">
          {hasMore ? (
            <button
              onClick={loadMore}
              disabled={loading}
              className="px-7 py-3 font-sans text-[10px] tracking-widest uppercase border border-border-mid text-foreground hover:border-foreground hover:bg-foreground hover:text-background transition-colors disabled:opacity-40"
            >
              {loading ? "Loading…" : "Load more →"}
            </button>
          ) : (
            <p className="font-display italic text-lg text-muted">That&apos;s all in this scope.</p>
          )}
        </div>
      </main>
    </div>
  );
}
