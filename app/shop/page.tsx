"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import {
  rankCards,
  interpretDwell,
  type ScoringSignals,
  type ClickSignalLike,
  type ScoringCard,
} from "@/lib/scoring";
import type { SteerInterpretation } from "@/lib/steer-interpret";
import { addSaved, removeSaved, readSaved } from "@/lib/saved";
import { MobileMenu } from "../_components/MobileMenu";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Product {
  objectID:     string;
  title:        string;
  brand:        string;
  retailer?:    string;
  price:        number | null;
  image_url:    string;
  product_url:  string;
  // Optional fields used by the session scoring algorithm
  category?:    string;
  color?:       string;
  price_range?: string;
}

type ViewMode = "grid" | "scroll";

function formatPrice(p: number | null): string {
  if (p == null) return "";
  return `$${Math.round(p).toLocaleString("en-US")}`;
}

// Current grid column count — mirrors Tailwind's `grid-cols-2 sm:grid-cols-3
// lg:grid-cols-4` breakpoints (sm=640, lg=1024). Used by mixBrands to enforce
// the "no brand repeats in a row" rule based on what the user is actually seeing.
function getGridCols(): number {
  if (typeof window === "undefined") return 4;
  if (window.matchMedia("(min-width: 1024px)").matches) return 4;
  if (window.matchMedia("(min-width: 640px)").matches)  return 3;
  return 2;
}

// Brand mixer — "rearrange-string" greedy with ONE hard rule and one soft
// preference. Applies to every scoped shop page (brand mode, every
// category page: Tops, Dresses, Bottoms, Knits, Bags, Shoes, Outerwear,
// Other) because it's run on the flat `products` list before render.
//
//   HARD: No two items from the same brand on the same grid row. If the
//         current pool can't fill the next slot without violating this,
//         we stop emitting — leftover items stay in `products` state and
//         get another chance on the next mix, once pagination brings
//         fresher brand diversity.
//   SOFT: Avoid same-brand adjacency across a row boundary. Tolerable to
//         violate when every non-prev brand is already on the current
//         row; a visible seam-run is acceptable, but the same brand
//         twice in one row is not.
//
// At each step we pick the brand with the MOST remaining items that's
// eligible under the hard rule, preferring non-adjacent. Frequency-first
// prevents a dominant brand from being held back until the end and dumped
// in an unmixable run. Within a brand, server order is preserved so the
// ranking signal survives.
// Array.from(...) instead of `for (const x of map)` because the repo's
// tsconfig has no `target` set, which lands on a default that tsc rejects
// Map iterators under without --downlevelIteration. Same workaround as
// commit 21c5ac7.
function mixBrands(list: Product[], cols: number): Product[] {
  if (list.length <= 1 || cols <= 0) return list;

  const buckets = new Map<string, Product[]>();
  for (const p of list) {
    const key = (p.brand ?? "").toLowerCase();
    const arr = buckets.get(key);
    if (arr) arr.push(p);
    else buckets.set(key, [p]);
  }

  const out: Product[] = [];

  while (buckets.size > 0) {
    const idx      = out.length;
    const rowStart = idx - (idx % cols);
    const prev     = (out[idx - 1]?.brand ?? "").toLowerCase();
    const rowBrands = new Set<string>();
    for (let i = rowStart; i < idx; i++) {
      const b = (out[i].brand ?? "").toLowerCase();
      if (b) rowBrands.add(b);
    }

    // Track two candidates: the best brand that's not in the row and not
    // equal to the previous brand (preferred), and the best brand that's
    // not in the row but IS equal to prev (adjacency fallback). Empty
    // brand strings bypass both rules.
    let bestNonAdj: string | null = null; let bestNonAdjN = -1;
    let bestAdj:    string | null = null; let bestAdjN    = -1;
    for (const [brand, items] of Array.from(buckets.entries())) {
      if (items.length === 0) continue;
      if (brand && rowBrands.has(brand)) continue; // HARD row rule
      if (brand && brand === prev) {
        if (items.length > bestAdjN) { bestAdj = brand; bestAdjN = items.length; }
      } else {
        if (items.length > bestNonAdjN) { bestNonAdj = brand; bestNonAdjN = items.length; }
      }
    }
    const picked = bestNonAdj ?? bestAdj;

    // No brand left that isn't already on this row. Stop — the leftover
    // items stay in `products` state and re-enter the mix on the next
    // render. This is the whole point of the hard rule: we'd rather
    // temporarily hide items than show a same-brand row.
    if (!picked) break;

    const arr = buckets.get(picked)!;
    out.push(arr.shift()!);
    if (arr.length === 0) buckets.delete(picked);
  }

  return out;
}

// ── Page ──────────────────────────────────────────────────────────────────────

// Thin Suspense wrapper. Required because ShopPageContent reads URL params
// via useSearchParams, which bails the page out of static rendering.
export default function ShopPage() {
  return (
    <Suspense fallback={null}>
      <ShopPageContent />
    </Suspense>
  );
}

function ShopPageContent() {
  // URL-driven scope. Reactive (via useSearchParams) so clicking a category
  // tile — which does a soft navigation to /shop?category=X — actually
  // updates the rendered mode without a full page reload.
  //   ?brand=X    → brand mode (linked from /brands)
  //   ?category=X → category mode (linked from the tiles on /shop)
  //   neither     → category-picker mode (no products, just the 8 tiles)
  const searchParams = useSearchParams();
  const brandFilter    = useMemo(() => searchParams?.get("brand")    ?? "", [searchParams]);
  const categoryFilter = useMemo(() => searchParams?.get("category") ?? "", [searchParams]);
  const isBrandMode    = !!brandFilter;
  const isCategoryMode = !isBrandMode && !!categoryFilter;
  const isPickerMode   = !isBrandMode && !isCategoryMode;
  const scopeLabel     = brandFilter || categoryFilter || "";

  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [products, setProducts] = useState<Product[]>([]);
  const [page, setPage]         = useState(0);
  const [loading, setLoading]   = useState(false);
  const [hasMore, setHasMore]   = useState(true);
  const seenIdsRef              = useRef<Set<string>>(new Set());
  const sentinelRef             = useRef<HTMLDivElement>(null);

  // Viewport column count — drives the brand-mixer's "max 2 per line" rule.
  // Updates on resize so a window-drag past a Tailwind breakpoint re-mixes.
  const [gridCols, setGridCols] = useState<number>(4);
  useEffect(() => {
    const update = () => setGridCols(getGridCols());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Display order = server-ranked products run through the brand mixer.
  // Derived (not state), so re-ranking on likes/dislikes composes cleanly:
  // setProducts writes the re-ranked list, mixBrands re-runs on top.
  const displayProducts = useMemo(
    () => mixBrands(products, gridCols),
    [products, gridCols],
  );

  // Free-text Steer input from the scroll view. `steerQuery` holds the raw
  // text the user typed (used for scope hashing + pre-filling the input when
  // re-opened); `steerInterp` holds the Claude-parsed structured filters
  // (price tier, categories, colors, search/avoid terms). Empty string +
  // null interp = no steer active.
  // `interpretingSteer` covers the ~1–2 s window while Claude runs so the
  // loader stays visible through the whole submit-to-refetch transition.
  const [steerQuery,       setSteerQuery]       = useState<string>("");
  const [steerInterp,      setSteerInterp]      = useState<SteerInterpretation | null>(null);
  const [interpretingSteer, setInterpretingSteer] = useState(false);

  // ── Session scoring algorithm state ────────────────────────────────────────
  // Mirrors the dashboard scoring pipeline: likes add to clickHistory, fast
  // swipes add to dislikedSignals, and both re-rank the upcoming queue so
  // session signals bubble up (or down) matching products that haven't been
  // seen yet.
  const [likedIds, setLikedIds]       = useState<Set<string>>(new Set());
  const [dwellTimes, setDwellTimes]   = useState<Record<string, number>>({});
  const clickHistoryRef               = useRef<ClickSignalLike[]>([]);
  const dislikedSignalsRef            = useRef<ClickSignalLike[]>([]);
  const activeScrollIdxRef            = useRef(0);

  // Saved products ("Your Edit"). Persisted to localStorage via lib/saved.
  // Only the ID set lives in component state — the full product rows are
  // in localStorage and /edit reads them directly, so we don't need to
  // double-store here.
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Hydrate from localStorage on mount.
    const rows = readSaved();
    setSavedIds(new Set(rows.map((r) => r.objectID)));
  }, []);

  // Transient confirmation banner ("saved to your shortlist"). Fades out after
  // ~2 seconds. Rendered at page level, fixed z-60 so it sits above the
  // scroll view overlay.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const productToSignal = (p: Product): ClickSignalLike => ({
    objectID:    p.objectID,
    category:    p.category ?? "",
    brand:       p.brand ?? "",
    color:       p.color ?? "",
    price_range: p.price_range ?? "mid",
    retailer:    p.retailer,
  });

  const buildSignals = useCallback((): ScoringSignals => ({
    likedProductIds: likedIds,
    clickHistory:    clickHistoryRef.current,
    dislikedSignals: dislikedSignalsRef.current,
    dwellTimes,
    aestheticPrice:  "mid", // /shop has no aesthetic profile; mid is a safe default
  }), [likedIds, dwellTimes]);

  // Re-rank only the unseen portion of the products list. Each product is
  // wrapped as a single-product ScoringCard so rankCards can evaluate it.
  const reRankUpcomingProducts = useCallback((list: Product[], activeIdx: number, signals: ScoringSignals): Product[] => {
    const seen     = list.slice(0, activeIdx + 1);
    const upcoming = list.slice(activeIdx + 1);
    if (upcoming.length <= 1) return list;
    const cards: ScoringCard[] = upcoming.map((p) => ({
      id:       p.objectID,
      products: [{
        objectID:    p.objectID,
        category:    p.category,
        brand:       p.brand,
        color:       p.color,
        price_range: p.price_range,
        retailer:    p.retailer,
      }],
      liked: signals.likedProductIds.has(p.objectID),
    }));
    const ranked = rankCards(cards, signals) as ScoringCard[];
    // Map ranked cards back to products by id
    const byId = new Map(upcoming.map((p) => [p.objectID, p]));
    const rankedProducts = ranked
      .map((c) => byId.get(c.id))
      .filter((p): p is Product => p != null);
    return [...seen, ...rankedProducts];
  }, []);

  // Dedupe incoming batches against everything already shown. Keeps pagination
  // from double-listing a product the server returns in two different pages
  // (happens occasionally when the biased query shifts between requests).
  const dedupeAgainstSeen = useCallback((batch: Product[]): Product[] => {
    const seen = seenIdsRef.current;
    const out: Product[] = [];
    for (const p of batch) {
      if (seen.has(p.objectID)) continue;
      seen.add(p.objectID);
      out.push(p);
    }
    return out;
  }, []);

  // Build a bias payload out of current session signals. Top-N brands,
  // categories, and colors from clickHistory (likes) and dislikedSignals
  // (fast-swipes), computed from the running refs so we always send the
  // freshest state on each pagination request.
  const buildBias = useCallback(() => {
    const byKey = <T extends string>(items: ClickSignalLike[], key: keyof ClickSignalLike, max: number): string[] => {
      const counts = new Map<string, number>();
      for (const it of items) {
        const v = String(it[key] ?? "").trim();
        if (!v) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, max)
        .map(([v]) => v) as T[];
    };
    const liked    = clickHistoryRef.current;
    const disliked = dislikedSignalsRef.current;
    return {
      likedBrands:        byKey<string>(liked, "brand", 5),
      likedCategories:    byKey<string>(liked, "category", 4),
      likedColors:        byKey<string>(liked, "color", 3),
      // Only call something "strongly disliked" if the user fast-swiped past
      // 2+ matching products. Single fast-swipe is noise.
      dislikedBrands:     (() => {
        const counts = new Map<string, number>();
        for (const s of disliked) {
          const v = (s.brand ?? "").trim();
          if (!v) continue;
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        return Array.from(counts.entries()).filter(([, n]) => n >= 2).map(([v]) => v);
      })(),
      dislikedCategories: (() => {
        const counts = new Map<string, number>();
        for (const s of disliked) {
          const v = (s.category ?? "").trim();
          if (!v) continue;
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        return Array.from(counts.entries()).filter(([, n]) => n >= 3).map(([v]) => v);
      })(),
    };
  }, []);

  // Catalog fetch. Scope is brand / category / steered-taste-query, resolved
  // server-side. Session-bias signals (likes/dislikes so far) rank-boost the
  // results. Pagination continues until the server says hasMore=false.
  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    if (isPickerMode) return; // No product fetch in category-picker mode.
    setLoading(true);
    try {
      const res = await fetch(`/api/shop-all`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          page,
          bias:           buildBias(),
          brandFilter:    brandFilter    ?? "",
          categoryFilter: categoryFilter ?? "",
          steerQuery,
          steerInterp,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("[shop] non-ok:", res.status, body);
        setHasMore(false);
        return;
      }
      const data  = await res.json();
      const fresh = (data.products ?? []) as Product[];
      const batch = dedupeAgainstSeen(fresh);
      setProducts((prev) => [...prev, ...batch]);
      setPage((p) => p + 1);
      if (!data.hasMore) setHasMore(false);
    } catch (err) {
      console.error("[shop] load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [page, loading, hasMore, dedupeAgainstSeen, buildBias, brandFilter, categoryFilter, steerQuery, steerInterp, isPickerMode]);

  // One-shot init guard. The useEffect below has deps that settle in stages
  // on mount (URL read swaps brand/category null → value); without a guard
  // the body would run 2–3 times in quick succession, firing duplicate
  // loadMore calls. initStartedRef blocks subsequent runs until the scope
  // (brand + category + steer) changes, at which point we reset and let
  // init fire again for the new scope.
  const initStartedRef = useRef(false);
  const lastScopeRef   = useRef<string>("__uninit__");

  useEffect(() => {
    // Scope change (brand / category / steer) = fresh init. We do the first
    // fetch inline rather than calling loadMore, because loadMore's closure
    // over `hasMore`/`loading` would still see stale (pre-reset) values if
    // we setHasMore(true) + invoke loadMore() in the same tick. Inlining
    // sidesteps that timing hazard cleanly.
    const scope = `${brandFilter}|${categoryFilter}|${steerQuery}`;
    if (lastScopeRef.current === scope && initStartedRef.current) return;
    lastScopeRef.current   = scope;
    initStartedRef.current = true;

    setProducts([]);
    setPage(0);
    setHasMore(true);
    seenIdsRef.current = new Set();

    if (isPickerMode) {
      setLoading(false);
      return;
    }

    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/shop-all`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            page:           0,
            bias:           buildBias(),
            brandFilter:    brandFilter    ?? "",
            categoryFilter: categoryFilter ?? "",
            steerQuery,
            steerInterp,
          }),
        });
        if (!res.ok) {
          setHasMore(false);
          return;
        }
        const data  = await res.json();
        const fresh = (data.products ?? []) as Product[];
        const seen  = seenIdsRef.current;
        const batch: Product[] = [];
        for (const p of fresh) {
          if (seen.has(p.objectID)) continue;
          seen.add(p.objectID);
          batch.push(p);
        }
        setProducts(batch);
        setPage(1);
        if (!data.hasMore) setHasMore(false);
      } catch (err) {
        console.error("[shop] init load failed:", err);
      } finally {
        setLoading(false);
      }
    })();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [brandFilter, categoryFilter, steerQuery, isPickerMode]);

  // ── Scoring-algorithm handlers ────────────────────────────────────────────

  // Single-flight guard so a burst of likes doesn't fire multiple parallel
  // biased fetches. If one's in the air, skip subsequent until it finishes.
  const biasRefetchInFlightRef = useRef(false);

  // After any meaningful signal change, pull a fresh biased batch from the
  // server and splice it in just past the active card. The user's current
  // card + the next one stay put (so the view doesn't jolt), but everything
  // beyond gets replaced with products that reflect the updated bias. So
  // their preference shows up in ~2 cards instead of ~48.
  const refreshBiasedAhead = useCallback(async () => {
    if (biasRefetchInFlightRef.current) return;
    // In brand mode the server applies brandFilter so the re-fetch stays
    // within the brand — it's safe to still run this path, which keeps the
    // feed responsive to session likes/dislikes inside the brand scope.
    const bias = buildBias();
    const hasLiked = (bias.likedBrands?.length ?? 0) > 0
      || (bias.likedCategories?.length ?? 0) > 0
      || (bias.likedColors?.length ?? 0) > 0;
    if (!hasLiked) return;
    biasRefetchInFlightRef.current = true;
    try {
      const res = await fetch(`/api/shop-all`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          page: 0,
          bias,
          brandFilter,
          categoryFilter,
          steerQuery,
          steerInterp,
        }),
      });
      if (!res.ok) return;
      const data  = await res.json();
      const fresh = (data.products ?? []) as Product[];
      if (fresh.length === 0) return;

      // Splice fresh products in at activeIdx + 2 so the next swipe lands
      // on something biased. Keep everything up to and including the next
      // card stable so the UI doesn't visibly jump.
      setProducts((prev) => {
        const insertAt = Math.min(activeScrollIdxRef.current + 2, prev.length);
        const keep     = prev.slice(0, insertAt);
        const keepIds  = new Set(keep.map((p) => p.objectID));
        const freshUnseen = fresh.filter((p) => !keepIds.has(p.objectID));
        // Track in global seen set so future flat/pool fetches don't dupe
        freshUnseen.forEach((p) => seenIdsRef.current.add(p.objectID));
        return [...keep, ...freshUnseen];
      });
      // Next loadMore should continue from page 1 of the biased query
      setPage(1);
      setHasMore(true);
    } catch (err) {
      console.warn("[shop] refreshBiasedAhead failed:", err);
    } finally {
      biasRefetchInFlightRef.current = false;
    }
  }, [buildBias, brandFilter, steerQuery, steerInterp, isBrandMode]);

  // Toggle-save handler. On a new save we also fire the toast. Unlike
  // handleLike, save does NOT feed the scoring algorithm — "saving" is a
  // bookmark action, not a taste signal.
  const handleSave = useCallback((productId: string) => {
    const product = products.find((p) => p.objectID === productId);
    if (!product) return;
    const isCurrentlySaved = savedIds.has(productId);
    if (isCurrentlySaved) {
      removeSaved(productId);
      setSavedIds((prev) => {
        const next = new Set(prev);
        next.delete(productId);
        return next;
      });
      return;
    }
    addSaved({
      objectID:    product.objectID,
      title:       product.title,
      brand:       product.brand,
      retailer:    product.retailer,
      price:       product.price,
      image_url:   product.image_url,
      product_url: product.product_url,
      category:    product.category,
      color:       product.color,
      price_range: product.price_range,
    });
    setSavedIds((prev) => new Set(prev).add(productId));
    setToast("saved to your shortlist");
  }, [products, savedIds]);

  const handleLike = useCallback((productId: string) => {
    const product = products.find((p) => p.objectID === productId);
    if (!product) return;
    const alreadyLiked = likedIds.has(productId);
    if (alreadyLiked) {
      // Unlike: just remove from the set; don't pop clickHistory (user may
      // genuinely have liked then unliked, but the affinity signal stays).
      setLikedIds((prev) => {
        const next = new Set(prev);
        next.delete(productId);
        return next;
      });
      return;
    }
    // New like → record signal + re-rank upcoming
    const signal = productToSignal(product);
    clickHistoryRef.current = [signal, ...clickHistoryRef.current].slice(0, 30);
    setLikedIds((prev) => {
      const next = new Set(prev);
      next.add(productId);
      return next;
    });
    setProducts((prev) => {
      const signals: ScoringSignals = {
        likedProductIds: new Set(Array.from(likedIds).concat(productId)),
        clickHistory:    clickHistoryRef.current,
        dislikedSignals: dislikedSignalsRef.current,
        dwellTimes,
        aestheticPrice:  "mid",
      };
      return reRankUpcomingProducts(prev, activeScrollIdxRef.current, signals);
    });
    // ...and pull a freshly-biased batch from the server so the next swipe
    // lands on products the catalog itself thinks match this new signal,
    // not just a reshuffle of what's already loaded.
    void refreshBiasedAhead();
  }, [products, likedIds, dwellTimes, reRankUpcomingProducts, refreshBiasedAhead]);

  const handleDwell = useCallback((productId: string, ms: number) => {
    setDwellTimes((prev) => ({ ...prev, [productId]: ms }));
    const signal = interpretDwell(ms);
    if (signal !== "strong_positive" && signal !== "negative") return;

    // Fast swipe past an UNliked product → capture its attributes as a
    // penalty signal so similar upcoming products get pushed down.
    if (signal === "negative") {
      const product = products.find((p) => p.objectID === productId);
      if (product && !likedIds.has(productId)) {
        dislikedSignalsRef.current = [productToSignal(product), ...dislikedSignalsRef.current].slice(0, 40);
      }
    }

    setProducts((prev) => {
      const signals: ScoringSignals = {
        likedProductIds: likedIds,
        clickHistory:    clickHistoryRef.current,
        dislikedSignals: dislikedSignalsRef.current,
        dwellTimes:      { ...dwellTimes, [productId]: ms },
        aestheticPrice:  "mid",
      };
      return reRankUpcomingProducts(prev, activeScrollIdxRef.current, signals);
    });
    // A fresh fast-swipe expands the disliked set, so pull a new biased
    // batch too — keeps the feed responsive rather than having to wait
    // until the next natural pagination trigger.
    if (signal === "negative") void refreshBiasedAhead();
  }, [products, likedIds, dwellTimes, reRankUpcomingProducts, refreshBiasedAhead]);

  // Steer submit from inside the scroll view.
  //
  // Ordering:
  //   1. Reset the feed immediately so the loader shows.
  //   2. Ask Claude to interpret the free text into structured filters
  //      (price_range, categories, colors, search_terms, avoid_terms)
  //      — this is what makes "cheaper" actually filter by price instead
  //      of searching for titles containing the word "cheaper".
  //   3. Commit the interpretation + raw text in one batch; the initial-
  //      load useEffect is keyed on steerQuery and picks it up to re-
  //      fetch with the new structured filter.
  //
  // Empty submit clears the filter entirely.
  //
  // IMPORTANT: never navigate away — the user is in a specific context
  // (brand or flat) and wants to refine it in place, not be kicked to
  // /dashboard.
  const handleSteer = useCallback(async (comment: string) => {
    const trimmed = comment.trim();

    // Immediate feed reset so the loader replaces the current grid.
    // Keep clickHistory / likedIds / disliked refs so session-accumulated
    // bias still applies on top of the steer.
    setProducts([]);
    setPage(0);
    setHasMore(true);
    setLoading(false);
    seenIdsRef.current = new Set();

    if (!trimmed) {
      // Empty submit → clear the steer.
      setSteerInterp(null);
      setSteerQuery("");
      return;
    }

    setInterpretingSteer(true);
    let interp: SteerInterpretation | null = null;
    try {
      const res = await fetch("/api/steer-interpret", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text: trimmed }),
      });
      if (res.ok) interp = (await res.json()) as SteerInterpretation;
    } catch (err) {
      console.warn("[shop] steer interpret failed:", err);
    }

    // Commit interp + raw text + unset interpreting in one batch.
    setInterpretingSteer(false);
    setSteerInterp(interp);
    setSteerQuery(trimmed);
  }, []);

  // infinite scroll sentinel (grid only — scroll mode has its own logic).
  // Don't observe until the first batch lands, so the 600px rootMargin can't
  // fire loadMore while the grid is still empty.
  const hasProducts = products.length > 0;
  useEffect(() => {
    if (viewMode !== "grid") return;
    if (!hasProducts) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadMore();
    }, { rootMargin: "600px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewMode, loadMore, hasProducts]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav — matches /brands + homepage cream-olive */}
      <header className="fixed top-0 left-0 right-0 z-50 px-8 py-2.5 bg-background/80 backdrop-blur-sm flex items-center justify-between">
        <Link href="/" className="font-display font-light text-base tracking-[0.22em] text-foreground hover:opacity-80 transition-opacity">
          MUSE
        </Link>
        <div className="hidden sm:flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase">
          <Link href="/shop"   className="text-foreground hover:text-accent transition-colors">Shop</Link>
          <Link href="/brands" className="text-muted hover:text-foreground transition-colors">Brands</Link>
          <Link href="/edit"   className="text-muted hover:text-foreground transition-colors">Your shortlist</Link>
          <Link href="/dashboard" className="text-muted hover:text-foreground transition-colors">Tailor to my taste →</Link>
        </div>
        <MobileMenu
          variant="cream"
          links={[
            { href: "/shop",      label: "Shop" },
            { href: "/brands",    label: "Brands" },
            { href: "/edit",      label: "Your shortlist" },
            { href: "/dashboard", label: "Tailor to my taste →" },
          ]}
        />
      </header>

      <main className="flex-1 pt-20 pb-24 px-8 max-w-7xl mx-auto w-full">
        {/* Header */}
        <div className="mb-10 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-6">
          <div>
            {isBrandMode ? (
              <>
                <Link href="/brands" className="font-sans text-[9px] tracking-widest uppercase text-muted hover:text-foreground transition-colors mb-4 inline-block">
                  ← All brands
                </Link>
                <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight mb-4">
                  {brandFilter}
                </h1>
                <p className="font-sans text-base text-muted-strong max-w-2xl leading-relaxed">
                  Everything in our catalog from {brandFilter}.
                </p>
              </>
            ) : isCategoryMode ? (
              <>
                <Link href="/shop" className="font-sans text-[9px] tracking-widest uppercase text-muted hover:text-foreground transition-colors mb-4 inline-block">
                  ← All categories
                </Link>
                <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight mb-4">
                  {categoryFilter}
                </h1>
                <p className="font-sans text-base text-muted-strong max-w-2xl leading-relaxed">
                  Every piece in {categoryFilter}.
                </p>
              </>
            ) : (
              <>
                <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">The catalog</p>
                <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight mb-4">
                  Shop
                </h1>
                <p className="font-sans text-base text-muted-strong max-w-2xl leading-relaxed">
                  Pick a category to browse. Over 100,000 pieces from vintage stores, eco-friendly labels, and small-batch makers.
                </p>
              </>
            )}
          </div>
          {!isBrandMode && !isCategoryMode && (
            <Link
              href="/dashboard"
              className="inline-block self-start sm:self-end px-6 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200 whitespace-nowrap"
            >
              Tailor to your taste →
            </Link>
          )}
        </div>

        {/* Category picker — home view only */}
        {isPickerMode && <CategoryPickerGrid />}

        {/* View toggle + product grid — only in brand/category mode */}
        {!isPickerMode && (
          <>
            <div className="flex items-center justify-between mb-10 border-y border-border-mid py-5">
              <div className="flex">
                <button
                  onClick={() => setViewMode("grid")}
                  aria-pressed={viewMode === "grid"}
                  className={`px-7 py-3 font-sans text-[11px] tracking-widest uppercase border transition-colors flex items-center gap-2.5 ${
                    viewMode === "grid"
                      ? "bg-foreground text-background border-foreground"
                      : "border-border-mid text-muted hover:text-foreground hover:border-foreground/60"
                  }`}
                >
                  <GridIcon active={viewMode === "grid"} />
                  Grid
                </button>
                <button
                  onClick={() => setViewMode("scroll")}
                  aria-pressed={viewMode === "scroll"}
                  className={`px-7 py-3 font-sans text-[11px] tracking-widest uppercase border border-l-0 transition-colors flex items-center gap-2.5 ${
                    viewMode === "scroll"
                      ? "bg-foreground text-background border-foreground"
                      : "border-border-mid text-muted hover:text-foreground hover:border-foreground/60"
                  }`}
                >
                  <ScrollIcon active={viewMode === "scroll"} />
                  Scroll
                </button>
              </div>
              <span className="font-sans text-[10px] tracking-widest uppercase text-muted">
                {products.length.toLocaleString()} loaded
              </span>
            </div>

            {viewMode === "grid" && (
              <>
                {products.length === 0 && (loading || interpretingSteer) && (
                  <div className="py-28 flex flex-col items-center justify-center text-center">
                    <p className="font-display font-light italic text-2xl sm:text-3xl text-muted-strong mb-3">
                      {interpretingSteer ? "Tuning the feed to what you asked for…" : "Loading your feed…"}
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5">
                  {displayProducts.map((p) => <GridTile key={p.objectID} product={p} />)}
                </div>
                {/* Sentinel only exists once products are on screen so the
                    IntersectionObserver can't fire loadMore at mount-time. */}
                {products.length > 0 && (
                  <div ref={sentinelRef} className="h-24 flex items-center justify-center mt-10">
                    {loading && <p className="font-display italic text-lg text-muted">Loading more…</p>}
                    {!hasMore && (
                      <p className="font-display italic text-lg text-muted">That&apos;s everything in {scopeLabel}.</p>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}

      </main>

      {/* Scroll view — modal overlay with a single narrow centered column.
          Only renders in scoped modes; picker mode has no products. */}
      {viewMode === "scroll" && !isPickerMode && (
        <ProductScrollView
          products={displayProducts}
          onNearEnd={loadMore}
          loading={loading}
          hasMore={hasMore}
          onClose={() => setViewMode("grid")}
          likedIds={likedIds}
          onLike={handleLike}
          onDwell={handleDwell}
          onActiveChange={(idx) => { activeScrollIdxRef.current = idx; }}
          onSteer={handleSteer}
          steerQuery={steerQuery}
          savedIds={savedIds}
          onSave={handleSave}
        />
      )}

      {/* Transient confirmation banner ("saved to your shortlist"). Lives at
          page level so it floats above the scroll view overlay (z-50).
          Fades in/out via inline transition + top/opacity. */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[60] pointer-events-none"
        >
          <div className="font-sans text-[10px] tracking-widest uppercase bg-foreground text-background px-5 py-2.5 shadow-xl">
            {toast}
          </div>
        </div>
      )}

      <footer className="border-t border-border px-8 py-7">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link href="/" className="font-display font-light tracking-[0.18em] text-sm text-muted hover:text-foreground transition-colors">MUSE</Link>
          <div className="flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase text-muted-dim">
            <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
            <span>© 2025</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ── Grid tile ─────────────────────────────────────────────────────────────────

function GridTile({ product }: { product: Product }) {
  const [imgFailed, setImgFailed] = useState(false);
  const brandLabel = product.brand || product.retailer || "";
  return (
    <a
      href={product.product_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="group block"
    >
      {/* Image — this is the only element with a border + shadow now. No
          bottom-gradient overlay anymore; the brand that used to sit there
          was getting clipped by the image edge. Moved out and below. */}
      <div className="aspect-[3/4] relative overflow-hidden bg-[rgba(42,51,22,0.04)] border border-border shadow-card group-hover:shadow-card-hover group-hover:border-border-mid transition-all duration-300">
        {product.image_url && !imgFailed ? (
          <Image
            src={product.image_url}
            alt={product.title}
            fill
            unoptimized
            className="object-cover object-top group-hover:scale-[1.04] transition-transform duration-700"
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            onError={() => setImgFailed(true)}
          />
        ) : null}
      </div>
      {/* Text row — lives outside the border now. Brand sits above the
          title in the accent olive; title + price below. No outer frame. */}
      <div className="pt-3">
        {brandLabel && (
          <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1">
            {brandLabel}
          </p>
        )}
        <p className="font-sans text-xs text-foreground leading-snug line-clamp-2 mb-2">
          {product.title}
        </p>
        <div className="flex items-center justify-between">
          {product.price != null ? (
            <span className="font-sans text-xs font-medium text-foreground">{formatPrice(product.price)}</span>
          ) : <span />}
          <span className="font-sans text-[9px] tracking-widest uppercase text-muted group-hover:text-accent transition-colors">Shop →</span>
        </div>
      </div>
    </a>
  );
}

// ── Category picker ──────────────────────────────────────────────────────────
// Home-view /shop: 7 category tiles, same visual pattern as /brands cards.
// Clicking a tile deep-links to /shop?category=NAME which switches this same
// page into category-scope product mode.

const CATEGORY_LABELS = [
  "Tops",
  "Dresses",
  "Bottoms",
  "Knits",
  "Bags and accessories",
  "Shoes",
  "Outerwear",
] as const;

interface CategorySample {
  label:    string;
  imageUrl: string | null;
  count:    number | null;
}

function CategoryPickerGrid() {
  const [samples, setSamples] = useState<Record<string, CategorySample>>({});
  const [loaded, setLoaded]   = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // No cache directive here. The route itself has revalidate: 300
        // (5 min Vercel-side cache), which is enough — force-cache on the
        // client would pin whatever JSON was fetched on first visit and
        // ignore every subsequent override, which is exactly the bug that
        // kept re-surfacing the old Shoes/Dresses hero images after they
        // were replaced in CATEGORY_IMAGE_OVERRIDE.
        const res = await fetch("/api/category-index");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const map: Record<string, CategorySample> = {};
        for (const c of (data?.categories ?? []) as CategorySample[]) {
          map[c.label] = c;
        }
        setSamples(map);
      } catch (err) {
        console.warn("[shop] category-index fetch failed:", err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5">
      {CATEGORY_LABELS.map((label) => (
        <CategoryCard key={label} label={label} sample={samples[label]} loaded={loaded} />
      ))}
    </div>
  );
}

function CategoryCard({
  label, sample, loaded,
}: {
  label:   string;
  sample:  CategorySample | undefined;
  loaded:  boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = sample?.imageUrl ?? null;
  return (
    <Link
      href={`/shop?category=${encodeURIComponent(label)}`}
      className="group relative aspect-[3/4] overflow-hidden bg-[rgba(42,51,22,0.04)] border border-border shadow-card hover:shadow-card-hover transition-all duration-300 block"
    >
      {src && !imgFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={label}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover object-top group-hover:scale-[1.04] transition-transform duration-700"
          onError={() => setImgFailed(true)}
        />
      ) : null}
      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent pointer-events-none" />
      <div className="absolute bottom-0 left-0 right-0 p-4">
        <h3 className="font-display font-light text-xl text-white leading-tight drop-shadow-sm">{label}</h3>
        {loaded && sample?.count != null && (
          <p className="font-sans text-[9px] tracking-widest uppercase text-white/70 mt-1">
            {sample.count.toLocaleString()} pieces
          </p>
        )}
      </div>
    </Link>
  );
}

// ── Scroll view — modal overlay, narrow centered scroll column ───────────────
// Matches the dashboard tailored-page scroll exactly: dimmed/blurred page
// backdrop, single column of product cards (~440px wide) centered on screen,
// each card has a full-bleed image with Like + Steer buttons pinned to its
// right edge and brand/title/price overlaid at the bottom.

function ProductScrollView({
  products, onNearEnd, loading, hasMore, onClose,
  likedIds, onLike, onDwell, onActiveChange,
  onSteer, steerQuery,
  savedIds, onSave,
}: {
  products:       Product[];
  onNearEnd:      () => void;
  loading:        boolean;
  hasMore:        boolean;
  onClose:        () => void;
  likedIds:       Set<string>;
  onLike:         (productId: string) => void;
  onDwell:        (productId: string, ms: number) => void;
  onActiveChange: (idx: number) => void;
  onSteer:        (comment: string) => void;
  steerQuery:     string;
  savedIds:       Set<string>;
  onSave:         (productId: string) => void;
}) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const isScrolling   = useRef(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const nearEndFired  = useRef(false);

  // Dwell tracking: when the active card changes, fire onDwell for the
  // one we just scrolled past with the time we spent on it.
  const cardEnteredAt = useRef<number>(Date.now());
  const prevIdxRef    = useRef<number>(0);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, clientHeight } = containerRef.current;
    const idx = Math.round(scrollTop / clientHeight);
    if (idx !== prevIdxRef.current) {
      const leaving = products[prevIdxRef.current];
      if (leaving) onDwell(leaving.objectID, Date.now() - cardEnteredAt.current);
      cardEnteredAt.current = Date.now();
      prevIdxRef.current    = idx;
    }
    setActiveIdx(idx);
    onActiveChange(idx);
    if (!nearEndFired.current && hasMore && idx >= products.length - 6) {
      nearEndFired.current = true;
      onNearEnd();
    }
  }, [products, hasMore, onNearEnd, onDwell, onActiveChange]);

  useEffect(() => { nearEndFired.current = false; }, [products.length]);

  // Wheel → snap by viewport height. Sensitivity bumped ~25% over the
  // original tuning:
  //   - delta threshold dropped 180 → 144 px, so a slightly smaller flick
  //     triggers an advance (still ignores micro-flicks)
  //   - cooldown dropped 1600 → 1280 ms so consecutive snaps feel quicker
  //   - accumulator resets after 200 ms of no wheel input so stale delta
  //     doesn't trigger a jump on the next session.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let deltaAccum = 0;
    let resetTimer: number | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (isScrolling.current) return;
      deltaAccum += e.deltaY;
      if (resetTimer != null) window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => { deltaAccum = 0; }, 200);
      if (Math.abs(deltaAccum) < 144) return;
      isScrolling.current = true;
      const direction = Math.sign(deltaAccum);
      deltaAccum = 0;
      el.scrollBy({ top: direction * el.clientHeight, behavior: "smooth" });
      setTimeout(() => { isScrolling.current = false; }, 1280);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (resetTimer != null) window.clearTimeout(resetTimer);
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || (a as HTMLElement).isContentEditable)) return;
      if (isScrolling.current) return;
      const step = (dir: 1 | -1) => {
        isScrolling.current = true;
        el.scrollBy({ top: dir * el.clientHeight, behavior: "smooth" });
        setTimeout(() => { isScrolling.current = false; }, 800);
      };
      switch (e.key) {
        case "ArrowDown": case "j": case " ": case "PageDown":
          e.preventDefault(); step(1); break;
        case "ArrowUp": case "k": case "PageUp":
          e.preventDefault(); step(-1); break;
        case "Escape":
          e.preventDefault(); onClose(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Steer submit → hand the comment up to ShopPage which applies it as a
  // text query over the current scope (brand or flat). Used to navigate
  // to /dashboard?describe=… which was wrong: the user's in a specific
  // catalog context and wants to refine it in place, not be kicked out.
  const handleSteerSubmit = useCallback((comment: string) => {
    onSteer(comment);
  }, [onSteer]);

  // Steer input toggle lives at the view level now so it follows the active
  // card instead of being re-created per scroll snap.
  const [showSayMore, setShowSayMore] = useState(false);
  const [sayMoreText, setSayMoreText] = useState("");
  // Close the Steer input when the user scrolls to a different card.
  useEffect(() => { setShowSayMore(false); }, [activeIdx]);
  // Pre-fill the input with the active steerQuery when it opens, so the
  // user can edit or clear the current filter instead of starting blank.
  useEffect(() => {
    if (showSayMore) setSayMoreText(steerQuery);
    else setSayMoreText("");
  }, [showSayMore, steerQuery]);

  const activeProduct = products[activeIdx];
  const activeLiked   = activeProduct ? likedIds.has(activeProduct.objectID) : false;
  const activeSaved   = activeProduct ? savedIds.has(activeProduct.objectID) : false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop.
          Was bg-background/40 + backdrop-blur-md. Looked great on Chrome
          where backdrop-filter blurs the underlying page to a soft cream
          wash — but iOS Safari de-prioritises backdrop-filter on lower-
          powered iPads, leaving only the 40% cream overlay. The fixed
          page header (also z-50) then bled through, stacking the MUSE
          wordmark and "← GRID" button on top of each other.
          Bumping the base opacity to 92% keeps the backdrop readable
          regardless of whether the blur filter actually rendered. */}
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute inset-0 bg-background/[0.92] backdrop-blur-md cursor-default"
      />

      {/* Top bar overlay — sits above the backdrop, not over the card */}
      <div className="absolute top-4 left-6 right-6 z-20 flex items-center justify-between pointer-events-none">
        <button
          onClick={onClose}
          className="pointer-events-auto font-sans text-[9px] tracking-widest uppercase text-foreground/70 hover:text-foreground transition-colors"
        >
          ← Grid
        </button>
        <span className="font-sans text-[9px] tracking-widest uppercase text-foreground/40">
          {Math.min(activeIdx + 1, products.length)} / {products.length}
        </span>
      </div>

      {/* Card + button rail.
          Desktop (sm+): horizontal flex with the 440px card centered and the
            rail as its right-hand sibling, gap-8 between them. Unchanged.
          Mobile (<sm): the outer flex collapses to fill the viewport; the
            card itself goes full-bleed (w-full h-full) and the rail is
            absolutely positioned over the card's right edge, TikTok-style. */}
      <div className="relative z-10 flex items-center w-full h-full sm:w-auto sm:h-auto sm:gap-8">
        {/* Card wrapper — positioning context for the Steer overlay AND, on
            mobile only, the rail. */}
        <div className="relative w-full h-full sm:w-auto sm:h-auto">
          {/* Scroll column — full-viewport on mobile, 440px column on desktop */}
          <div
            ref={containerRef}
            onScroll={handleScroll}
            className="no-scrollbar w-full h-full sm:w-[440px] sm:max-w-[92vw] sm:h-[88vh] overflow-y-scroll overflow-x-hidden bg-background shadow-2xl"
            style={{ scrollSnapType: "y mandatory" }}
          >
            {products.map((p, i) => (
              <ProductScrollCard
                key={p.objectID}
                product={p}
                index={i}
                activeIdx={activeIdx}
              />
            ))}
            {loading && (
              <div className="w-full flex items-center justify-center bg-background" style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}>
                <p className="font-display italic text-xl text-muted">Loading more…</p>
              </div>
            )}
            {!hasMore && !loading && (
              <div className="w-full flex items-center justify-center bg-background" style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}>
                <p className="font-display italic text-xl text-muted">That&apos;s everything.</p>
              </div>
            )}
          </div>

          {/* Steer input — centered across the card (NOT the viewport).
              Narrower than the card itself so it reads as a whispered aside
              over the product image rather than a full-width search bar. */}
          {showSayMore && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                // Submit even if empty — that clears an active steer.
                handleSteerSubmit(sayMoreText.trim());
                setShowSayMore(false);
                setSayMoreText("");
              }}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 w-[300px] max-w-[80%]"
            >
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  value={sayMoreText}
                  onChange={(e) => setSayMoreText(e.target.value)}
                  placeholder="more minimalist… no florals…"
                  className="flex-1 bg-background border border-border-mid px-3 py-2 font-display font-light italic text-base text-foreground placeholder-muted/80 focus:outline-none focus:border-foreground/60"
                />
                <button type="submit" className="px-3 py-2 bg-foreground text-background font-sans text-[9px] tracking-widest uppercase whitespace-nowrap">
                  →
                </button>
              </div>
            </form>
          )}

          {/* Mobile rail — overlaid on the card's bottom-right, above the
              product info overlay. Hidden on sm+ (the desktop rail below
              handles that case via flex). */}
          <div className="sm:hidden absolute right-3 bottom-40 z-20 flex flex-col items-center gap-5">
            <RailButton
              label={activeLiked ? "Liked" : "Like"}
              onClick={() => { if (activeProduct) onLike(activeProduct.objectID); }}
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5"
                fill={activeLiked ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
              </svg>
            </RailButton>
            <RailButton
              label={showSayMore ? "Cancel" : "Steer"}
              onClick={() => setShowSayMore((v) => !v)}
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5"
                fill={showSayMore ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </RailButton>
            {/* Save — same cream/olive aesthetic as Like + Steer. Bookmark
                icon fills olive when the active card is saved. Toast on
                the page layer confirms "saved to your shortlist". */}
            <RailButton
              label={activeSaved ? "Saved" : "Save"}
              onClick={() => { if (activeProduct) onSave(activeProduct.objectID); }}
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5"
                fill={activeSaved ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
              </svg>
            </RailButton>
          </div>
        </div>

        {/* Desktop rail — flex sibling of the card, hidden on mobile. */}
        <div className="hidden sm:flex flex-col items-center gap-6">
          <RailButton
            label={activeLiked ? "Liked" : "Like"}
            onClick={() => { if (activeProduct) onLike(activeProduct.objectID); }}
          >
            {/* When liked, the heart fills olive (currentColor === olive
                foreground). Rest state: outline only. */}
            <svg viewBox="0 0 24 24" className="w-5 h-5"
              fill={activeLiked ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
          </RailButton>

          <RailButton
            label={showSayMore ? "Cancel" : "Steer"}
            onClick={() => setShowSayMore((v) => !v)}
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5"
              fill={showSayMore ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </RailButton>

          {/* Save — sits below Steer. Same cream/olive aesthetic; bookmark
              icon fills olive when the active card is saved. */}
          <RailButton
            label={activeSaved ? "Saved" : "Save"}
            onClick={() => { if (activeProduct) onSave(activeProduct.objectID); }}
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5"
              fill={activeSaved ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
          </RailButton>
        </div>
      </div>
    </div>
  );
}

// ── Rail button: French-minimalist round button in the site's olive palette.
// The button container stays cream + thin olive border at all times — the
// active state is communicated by the ICON itself (heart fills olive, etc.),
// not by flipping the whole button to filled olive.

function RailButton({
  label, onClick, children,
}: {
  label:    string;
  onClick:  () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-center gap-2 transition-transform active:scale-95"
    >
      <div className="w-11 h-11 rounded-full flex items-center justify-center border bg-background border-border-mid text-foreground group-hover:border-foreground/60 group-hover:-translate-y-0.5 group-hover:shadow-sm transition-all duration-200">
        {children}
      </div>
      <span className="font-sans text-[9px] tracking-widest uppercase text-muted group-hover:text-foreground transition-colors">
        {label}
      </span>
    </button>
  );
}

// ── Scroll card — full-bleed image in the column, buttons on right edge ──────

function ProductScrollCard({
  product, index, activeIdx,
}: {
  product:   Product;
  index:     number;
  activeIdx: number;
}) {
  const isNear = Math.abs(index - activeIdx) <= 2;

  return (
    <a
      href={product.product_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="relative flex flex-col bg-background block"
      style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}
      data-card-index={index}
    >
      {/* Full-bleed image fills the card */}
      <div className="absolute inset-0 bg-[rgba(42,51,22,0.04)]">
        {product.image_url ? (
          <Image
            src={product.image_url}
            alt={product.title}
            fill
            unoptimized
            priority={isNear}
            className="object-cover"
            sizes="(max-width: 640px) 100vw, 440px"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted/20 font-display text-6xl">▢</div>
        )}
      </div>

      {/* Bottom overlay — brand, title, price, shop */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-5 py-6 bg-gradient-to-t from-background via-background/85 to-transparent">
        {product.brand && <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1">{product.brand}</p>}
        <p className="font-display font-light text-xl text-foreground leading-snug mb-1 break-words">{product.title}</p>
        {product.price != null && <p className="font-sans text-sm text-muted-strong mb-3">{formatPrice(product.price)}</p>}
        <span className="inline-block font-sans text-[9px] tracking-widest uppercase text-foreground border-b border-foreground/30 pb-px">Shop →</span>
      </div>
    </a>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function GridIcon({ active }: { active: boolean }) {
  const c = active ? "currentColor" : "currentColor";
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="5" height="5" stroke={c} strokeWidth="1.2" />
      <rect x="8" y="1" width="5" height="5" stroke={c} strokeWidth="1.2" />
      <rect x="1" y="8" width="5" height="5" stroke={c} strokeWidth="1.2" />
      <rect x="8" y="8" width="5" height="5" stroke={c} strokeWidth="1.2" />
    </svg>
  );
}

function ScrollIcon({ active }: { active: boolean }) {
  const c = active ? "currentColor" : "currentColor";
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="1" width="8" height="4" stroke={c} strokeWidth="1.2" />
      <rect x="3" y="9" width="8" height="4" stroke={c} strokeWidth="1.2" />
    </svg>
  );
}
