"use client";

/**
 * /admin/label/[category] — per-category golden-set labeling tool.
 *
 * Hard-scoped: when the URL says `/admin/label/shoes`, you only see shoes.
 * The existing user-toggleable category filter is gone — keeping the
 * labeler in a single silhouette is the whole point of splitting the
 * datasets per category.
 *
 * Each category has its own localStorage key + downloaded JSON file +
 * generated eval-set + age centroids. Independent everything.
 *
 * Multi-label is preserved from the previous version: an item can belong
 * to multiple age buckets simultaneously.
 *
 * Workflow
 * --------
 *   1. Tap age pills under each tile — multiple per item OK.
 *   2. Progress bars at top track X/TARGET per age range.
 *   3. localStorage auto-save on every click.
 *   4. ↓ Download JSON when done — file lands as
 *      `eval-labels-<category>-<ts>.json`. Move to
 *      `data/eval-labels-<category>.json` and run the build scripts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notFound, useParams } from "next/navigation";
import Link from "next/link";
import { categoryFromSlug, type CategoryRow } from "@/lib/category-taxonomy";

// ── Config ────────────────────────────────────────────────────────────────────

interface Aesthetic {
  key:   string;
  label: string;
  tint:  string;
}

const AESTHETICS: readonly Aesthetic[] = [
  { key: "age-13-18",   label: "13–18", tint: "border-[#3a8aaa] bg-[#3a8aaa] text-[#FAFAF5]" },
  { key: "age-18-25",   label: "18–25", tint: "border-[#6a2a3a] bg-[#6a2a3a] text-[#FAFAF5]" },
  { key: "age-25-32",   label: "25–32", tint: "border-[#2A3316] bg-[#2A3316] text-[#FAFAF5]" },
  { key: "age-32-plus", label: "32+",   tint: "border-[#1a2a4a] bg-[#1a2a4a] text-[#FAFAF5]" },
];

const TARGET_PER_AESTHETIC = 40;

/** Per-category localStorage key. Slug is part of the key so each category's
 *  state is independent — switching tabs between /admin/label/shoes and
 *  /admin/label/dresses doesn't cross-contaminate. */
function storageKey(slug: string): string {
  return `muse-eval-labels-${slug}-v1`;
}

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
  /** objectID → array of aesthetic keys (multi-label). */
  labels:    Record<string, string[]>;
  /** Product metadata shown so the export contains title/brand/image. */
  products:  Record<string, { title: string; brand: string; image_url: string; category?: string }>;
  updatedAt: string;
  /** Slug of the category this store is scoped to. Belt-and-braces — the
   *  storage key already encodes the slug, but persisting it here protects
   *  against accidental cross-category writes. */
  category:  string;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function emptyStore(slug: string): LabelStore {
  return { version: 1, labels: {}, products: {}, updatedAt: new Date().toISOString(), category: slug };
}

/** Map legacy age keys onto the current taxonomy. age-32-40 and age-40-60
 *  were collapsed into a single open-ended age-32-plus bucket; both old keys
 *  migrate forward so users who already labeled with the old taxonomy don't
 *  lose work. */
function migrateAgeKey(k: string): string {
  if (k === "age-32-40" || k === "age-40-60") return "age-32-plus";
  return k;
}

function loadStore(slug: string): LabelStore {
  if (typeof window === "undefined") return emptyStore(slug);
  try {
    const raw = localStorage.getItem(storageKey(slug));
    if (!raw) return emptyStore(slug);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.labels) return emptyStore(slug);

    // Defensive normalisation + age-key migration. An item that previously
    // carried both age-32-40 AND age-40-60 collapses to a single age-32-plus
    // (deduped via Set) so labels stay clean after the merge.
    const labels: Record<string, string[]> = {};
    for (const [id, v] of Object.entries(parsed.labels as Record<string, unknown>)) {
      const raw: string[] = Array.isArray(v)
        ? v.filter((k): k is string => typeof k === "string")
        : typeof v === "string" && v.length > 0
          ? [v]
          : [];
      const migrated = Array.from(new Set(raw.map(migrateAgeKey)));
      if (migrated.length > 0) labels[id] = migrated;
    }
    return {
      version:   1,
      labels,
      products:  (parsed.products ?? {}) as LabelStore["products"],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      category:  slug,
    };
  } catch {
    return emptyStore(slug);
  }
}

function saveStore(slug: string, store: LabelStore) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(storageKey(slug), JSON.stringify(store));
  } catch {
    // QuotaExceeded is possible with many uploads — best-effort write.
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PerCategoryLabelPage() {
  const params = useParams<{ category: string }>();
  const slug   = String(params?.category ?? "");
  const cat    = categoryFromSlug(slug);

  // Invalid category slug → 404. Keeps the surface tight; only the canonical
  // 7 slugs render anything.
  if (!cat) {
    if (typeof window !== "undefined") notFound();
    return null;
  }

  return <Labeler category={cat} />;
}

function Labeler({ category }: { category: CategoryRow }) {
  const [store, setStore]       = useState<LabelStore>(() => emptyStore(category.slug));
  const [products, setProducts] = useState<Product[]>([]);
  const [page, setPage]         = useState(0);
  const [loading, setLoading]   = useState(false);
  const [hasMore, setHasMore]   = useState(true);
  const [hideTagged, setHideTagged] = useState(false);
  const seenIdsRef              = useRef<Set<string>>(new Set());
  // Sentinel that sits just above the manual Load-more button. When it
  // scrolls into view, loadMore() fires automatically. The visible button
  // remains as a manual fallback in case IntersectionObserver doesn't run
  // (browser policy, off-screen tab, etc.).
  const sentinelRef             = useRef<HTMLDivElement>(null);

  // Hydrate on mount + whenever slug changes (route swap between categories).
  useEffect(() => {
    setStore(loadStore(category.slug));
  }, [category.slug]);

  // Reset product list whenever category changes (in case the user navigates
  // between sibling category pages without a full reload).
  useEffect(() => {
    setProducts([]);
    setPage(0);
    setHasMore(true);
    seenIdsRef.current = new Set();
  }, [category.slug]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const res = await fetch("/api/shop-all", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          page,
          // Hard-scoped to this page's category. The user CANNOT change it.
          categoryFilter: category.filter,
          brandFilter:    "",
          bias:            {},
          likedProductIds: [],
          steerQuery:      "",
          steerInterp:     null,
          // Diversify-by-brand: server fires multiple offset queries within
          // the scope and round-robins so the first batch isn't dominated
          // by the 3-5 brands at the top of desc(price). Critical for
          // labeling — we need to SEE the full brand variety per category,
          // not just the luxury subset.
          diversify:       true,
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
  }, [page, loading, hasMore, category.filter]);

  // Initial load when products list is empty.
  useEffect(() => {
    if (products.length === 0 && hasMore && !loading) {
      void loadMore();
    }
  }, [products.length, hasMore, loading, loadMore]);

  // Infinite scroll — IntersectionObserver on the sentinel div near the
  // bottom of the grid. When it enters the viewport (with a 600px rootMargin
  // for early prefetch), auto-call loadMore so the user can keep scrolling
  // without hunting for the button. Re-attaches when hasMore / loading
  // change so a stale closure doesn't fire on a "done" state.
  useEffect(() => {
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;
    const obs = new IntersectionObserver((entries) => {
      const isVisible = entries.some((e) => e.isIntersecting);
      if (isVisible && hasMore && !loading) void loadMore();
    }, { rootMargin: "600px" });
    obs.observe(node);
    return () => obs.disconnect();
  }, [hasMore, loading, loadMore, products.length]);

  // Toggle-an-aesthetic on a product. Multi-label semantics — clicking a
  // pill adds it if absent, removes it if present. Empty array clears the
  // entry entirely so localStorage stays tidy.
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
      saveStore(category.slug, next);
      return next;
    });
  }, [category.slug]);

  // Counts per aesthetic. One item in multiple buckets counts in each.
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

  const activeKeys = useMemo(() => new Set(AESTHETICS.map((a) => a.key)), []);
  const total      = Object.values(store.labels).reduce(
    (n, arr) => n + arr.filter((k) => activeKeys.has(k)).length,
    0,
  );
  const target     = AESTHETICS.length * TARGET_PER_AESTHETIC;

  const visibleProducts = useMemo(
    () => hideTagged
      ? products.filter((p) => {
          const arr = store.labels[p.objectID] ?? [];
          return !arr.some((k) => activeKeys.has(k));
        })
      : products,
    [products, hideTagged, store.labels, activeKeys],
  );

  // Export — file name carries the category slug so the user can drop
  // multiple downloads side-by-side without confusion.
  const downloadJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const ts   = new Date().toISOString().replace(/[:.]/g, "-");
    a.href     = url;
    a.download = `eval-labels-${category.slug}-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [store, category.slug]);

  const resetAll = useCallback(() => {
    if (!confirm(`Wipe ALL labels for ${category.label} from localStorage? This can't be undone.`)) return;
    const fresh = emptyStore(category.slug);
    setStore(fresh);
    saveStore(category.slug, fresh);
  }, [category]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 bg-background/95 backdrop-blur-sm border-b border-border-mid">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-5">
              <Link href="/" className="font-display font-light text-base tracking-[0.22em] text-foreground">
                MUSE
              </Link>
              <Link href="/admin/label" className="font-sans text-[9px] tracking-widest uppercase text-muted hover:text-foreground transition-colors">
                ← All categories
              </Link>
              <span className="font-sans text-[9px] tracking-widest uppercase text-foreground">
                {category.label}
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

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {AESTHETICS.map((a) => {
              const n   = counts[a.key] ?? 0;
              const pct = Math.min(100, (n / TARGET_PER_AESTHETIC) * 100);
              const done = n >= TARGET_PER_AESTHETIC;
              return (
                <div key={a.key} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between">
                    <span className="font-sans text-[10px] tracking-widest uppercase text-muted-strong">{a.label}</span>
                    <span className={`font-sans text-[10px] tracking-widest uppercase tabular-nums ${done ? "text-accent" : "text-muted"}`}>
                      {n}/{TARGET_PER_AESTHETIC}
                    </span>
                  </div>
                  <div className="h-0.5 bg-border w-full">
                    <div className="h-full bg-foreground transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-3 font-sans text-[10px] text-muted italic">
            Tap as many ranges as apply — one item can live in multiple buckets.
          </p>
        </div>
      </header>

      {/* Thin controls row — just hide-tagged. No category picker; we're
          locked to the URL category. */}
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-3 border-b border-border">
        <span className="font-sans text-[9px] tracking-widest uppercase text-muted-dim">
          Showing {category.label} only
        </span>
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

      <main className="max-w-7xl mx-auto px-6 py-8">
        {products.length === 0 && loading && (
          <p className="font-display italic text-xl text-muted text-center py-24">Loading {category.label.toLowerCase()}…</p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {visibleProducts.map((p) => {
            const tagged = store.labels[p.objectID] ?? [];
            const primaryAesthetic = AESTHETICS.find((a) => tagged.includes(a.key));
            return (
              <div
                key={p.objectID}
                className={`flex flex-col border-2 transition-colors ${
                  primaryAesthetic ? primaryAesthetic.tint.split(" ")[0] : "border-transparent"
                }`}
              >
                <div className="aspect-[3/4] bg-[rgba(42,51,22,0.04)] overflow-hidden">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.image_url} alt={p.title} loading="lazy" decoding="async" className="w-full h-full object-cover" />
                </div>

                <div className="px-1 pt-2">
                  <p className="font-sans text-[9px] tracking-widest uppercase text-muted truncate">{p.brand}</p>
                  <p className="font-sans text-xs text-foreground leading-tight line-clamp-2 mb-2">{p.title}</p>
                </div>

                <div className="flex flex-wrap gap-1 p-1">
                  {AESTHETICS.map((a) => {
                    const active = tagged.includes(a.key);
                    return (
                      <button
                        key={a.key}
                        onClick={() => toggleLabel(p, a.key)}
                        title={a.label}
                        className={`flex-1 min-w-0 px-1.5 py-1 font-sans text-[9px] tracking-widest uppercase border transition-colors truncate ${
                          active ? a.tint : "border-border-mid text-muted hover:text-foreground hover:border-foreground/60"
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

        {/* Sentinel — drives the infinite-scroll auto-fetch via the
            IntersectionObserver wired up above. Sits 600px ABOVE the
            manual button so loading kicks in before the user reaches
            the bottom and the button never feels "needed". */}
        <div ref={sentinelRef} aria-hidden className="h-px" />

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
            <p className="font-display italic text-lg text-muted">That&apos;s all of {category.label.toLowerCase()}.</p>
          )}
        </div>
      </main>
    </div>
  );
}
