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

/** localStorage key. v2 = multi-label: each product can belong to multiple
 *  age buckets (e.g., 13-18 AND 18-25). v1 data (single-label) is migrated
 *  on first load and the v1 key is deleted. */
const STORAGE_KEY    = "muse-eval-labels-v2";
const LEGACY_KEY_V1  = "muse-eval-labels-v1";

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
  /** objectID → array of aesthetic keys. An item tagged with multiple age
   *  buckets counts toward each bucket's progress and ends up in each
   *  bucket's kept-set when the converter runs. */
  labels:    Record<string, string[]>;
  /** Product metadata we've seen, so the export includes title/brand/image. */
  products:  Record<string, { title: string; brand: string; image_url: string; category?: string }>;
  updatedAt: string;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function emptyStore(): LabelStore {
  return { version: 2, labels: {}, products: {}, updatedAt: new Date().toISOString() };
}

/**
 * Load the current store. Handles three cases:
 *   1. v2 data present under STORAGE_KEY → return as-is.
 *   2. v1 data present under LEGACY_KEY_V1 (single-label: id → string) →
 *      migrate each value into a single-element array, write to v2 key,
 *      delete the legacy key.
 *   3. Neither → empty store.
 */
function loadStore(): LabelStore {
  if (typeof window === "undefined") return emptyStore();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.labels) {
        // Defensive normalisation — if any value isn't an array of strings,
        // coerce it so the UI never sees a malformed entry.
        const labels: Record<string, string[]> = {};
        for (const [id, v] of Object.entries(parsed.labels as Record<string, unknown>)) {
          if (Array.isArray(v)) {
            labels[id] = v.filter((k): k is string => typeof k === "string");
          } else if (typeof v === "string" && v.length > 0) {
            labels[id] = [v];
          }
        }
        return {
          version:   2,
          labels,
          products:  (parsed.products ?? {}) as LabelStore["products"],
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        };
      }
    }

    // v1 migration path. Preserves any single-label data from the previous
    // taxonomy (or previous tool version) as single-element arrays.
    const legacyRaw = localStorage.getItem(LEGACY_KEY_V1);
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw);
      const labels: Record<string, string[]> = {};
      for (const [id, v] of Object.entries((parsed?.labels ?? {}) as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0) labels[id] = [v];
        else if (Array.isArray(v))                  labels[id] = v.filter((k): k is string => typeof k === "string");
      }
      const migrated: LabelStore = {
        version:   2,
        labels,
        products:  (parsed?.products ?? {}) as LabelStore["products"],
        updatedAt: new Date().toISOString(),
      };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated)); } catch { /* quota */ }
      try { localStorage.removeItem(LEGACY_KEY_V1); } catch { /* ignore */ }
      return migrated;
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

  // Toggle a single aesthetic on a product. Each tile can carry multiple
  // active aesthetics at once — clicking a pill adds it if absent, removes
  // it if present. When the last pill is removed, the item is forgotten
  // entirely (the empty array gets cleared so localStorage stays tidy).
  const toggleLabel = useCallback((product: Product, aestheticKey: string) => {
    setStore((prev) => {
      const next: LabelStore = {
        ...prev,
        labels:   { ...prev.labels },
        products: { ...prev.products },
      };
      const current = next.labels[product.objectID] ?? [];
      const hasIt   = current.includes(aestheticKey);

      const nextArr = hasIt
        ? current.filter((k) => k !== aestheticKey)
        : [...current, aestheticKey];

      if (nextArr.length === 0) {
        delete next.labels[product.objectID];
        // Keep the product metadata around — we might re-tag it later
        // without having to re-fetch. The export strips products that
        // aren't labeled so unused metadata doesn't end up in the JSON.
      } else {
        next.labels[product.objectID] = nextArr;
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

  // Counts per aesthetic for the progress bars. One item can live in
  // multiple buckets simultaneously, so these counts sum to ≥ the unique
  // item count, not ==.
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of AESTHETICS) m[a.key] = 0;
    for (const arr of Object.values(store.labels)) {
      for (const k of arr) {
        if (m[k] != null) m[k]++;
      }
    }
    return m;
  }, [store.labels]);

  // Total = sum of per-bucket counts (tracks total labelling effort, not
  // unique items). Orphan aesthetic keys from a past taxonomy get excluded
  // so the counter doesn't inflate with dead data.
  const activeKeys = useMemo(() => new Set(AESTHETICS.map((a) => a.key)), []);
  const total      = Object.values(store.labels).reduce(
    (n, arr) => n + arr.filter((k) => activeKeys.has(k)).length,
    0,
  );
  const target     = AESTHETICS.length * TARGET_PER_AESTHETIC;

  // "Tagged" for the hide-tagged toggle = labeled with at least one
  // currently-active aesthetic. Items whose only labels are orphans from
  // an older taxonomy stay visible so the user can re-tag them.
  const visibleProducts = useMemo(
    () => hideTagged
      ? products.filter((p) => {
          const arr = store.labels[p.objectID] ?? [];
          return !arr.some((k) => activeKeys.has(k));
        })
      : products,
    [products, hideTagged, store.labels, activeKeys],
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

          {/* Multi-label hint — kept small so it doesn't compete with the
              progress bars above, but visible enough that a first-time
              labeler doesn't assume it's one-per-item like most UIs. */}
          <p className="mt-3 font-sans text-[10px] text-muted italic">
            Tap as many ranges as apply — one item can live in multiple buckets.
          </p>
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
            const tagged = store.labels[p.objectID] ?? [];
            // Border color = tint of the FIRST active aesthetic (in
            // AESTHETICS order — youngest bucket first). With multi-label
            // we could do a two-tone / gradient border but it's visual
            // noise for a 2-hour internal tool. Any active aesthetic is
            // enough of a "tagged" signal; specific colors matter less.
            const primaryAesthetic = AESTHETICS.find((a) => tagged.includes(a.key));
            return (
              <div
                key={p.objectID}
                className={`flex flex-col border-2 transition-colors ${
                  primaryAesthetic ? primaryAesthetic.tint.split(" ")[0] : "border-transparent"
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

                {/* Aesthetic pills — multiple can be active at once */}
                <div className="flex flex-wrap gap-1 p-1">
                  {AESTHETICS.map((a) => {
                    const active = tagged.includes(a.key);
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
