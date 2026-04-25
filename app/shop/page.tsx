"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useSearchParams, usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  rankCards,
  interpretDwell,
  type ScoringSignals,
  type ClickSignalLike,
  type ScoringCard,
} from "@/lib/scoring";
import type { SteerInterpretation } from "@/lib/steer-interpret";
import { fastParseSteerText, mergeSteerResults } from "@/lib/steer-fast-parse";
import { addSaved, removeSaved, readSaved, getShortlistSignals } from "@/lib/saved";
import {
  loadSessionSignals,
  saveSessionSignals,
  flushSessionSignals,
} from "@/lib/session-signals";
import { MobileMenu } from "../_components/MobileMenu";
import { TasteShopFlow } from "../_components/TasteShopFlow";
import { displayTitle } from "@/lib/algolia";

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
  // English back-fills (scripts/translate-non-english.mjs). When the brand
  // publishes in French / Italian / German / Portuguese / Spanish, these
  // hold a Haiku translation; the in-app surface prefers them over the
  // raw `title` / `description`. Outbound link still goes to the native
  // brand site.
  title_en?:          string;
  description_en?:    string;
  original_language?: string;
}


type ViewMode = "grid" | "scroll";

// Sort modes for the loaded grid. "featured" is the catalog's native order
// (Algolia customRanking, currently desc(price) at the index level — but we
// don't surface that detail in the label since it can change). The two
// price modes sort the LOADED set client-side; "Load more" continues to fetch
// in the catalog's native order, then the new batch is re-sorted on arrival.
type SortMode = "featured" | "price_asc" | "price_desc";

const SORT_OPTIONS: ReadonlyArray<{ label: string; value: SortMode }> = [
  { label: "Featured",    value: "featured"   },
  { label: "Price ↑",     value: "price_asc"  },
  { label: "Price ↓",     value: "price_desc" },
];

function sortProducts<T extends { price: number | null }>(items: T[], mode: SortMode): T[] {
  if (mode === "featured") return items;
  // Items with no price always sink to the bottom in either direction so a
  // missing price doesn't accidentally win "cheapest" or "most expensive".
  const withPrice    = items.filter((p) => p.price != null);
  const withoutPrice = items.filter((p) => p.price == null);
  withPrice.sort((a, b) => mode === "price_asc"
    ? (a.price as number) - (b.price as number)
    : (b.price as number) - (a.price as number));
  return [...withPrice, ...withoutPrice];
}

function formatPrice(p: number | null): string {
  if (p == null) return "";
  return `$${Math.round(p).toLocaleString("en-US")}`;
}

// Max-price filter presets for category / brand views. Plain pills — "Any"
// plus four caps. Kept small on purpose: the goal is "don't show me vintage
// Chanel at $12K while I'm browsing Bottoms," not a full range-slider UX.
const PRICE_CAPS: ReadonlyArray<{ label: string; value: number | null }> = [
  { label: "Any",      value: null  },
  { label: "Under $100",  value: 100   },
  { label: "Under $250",  value: 250   },
  { label: "Under $500",  value: 500   },
  { label: "Under $1K",   value: 1000  },
];

// Note: the brand-mixer that used to live here (enforcing "no same brand
// twice in a row") was removed. It was silently truncating the grid to a
// handful of cards whenever the fetched pool was dominated by one or two
// brands — e.g. category views right after a reclassification pass, or any
// brand-mode page by definition. Products now render in server order; let
// the ranking signal stand on its own.

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
  //   ?category=X → category mode (linked from category tiles on /shop)
  //   ?all=1      → all-products mode (the "Shop all" tile — no scope
  //                 filter, the API falls into its flat-pagination lane and
  //                 walks the whole catalog)
  //   neither     → category-picker mode (no products, just the tiles)
  const searchParams = useSearchParams();
  const pathname     = usePathname() ?? "/shop";
  const brandFilter    = useMemo(() => searchParams?.get("brand")    ?? "", [searchParams]);
  const categoryFilter = useMemo(() => searchParams?.get("category") ?? "", [searchParams]);
  const allFlag        = useMemo(() => searchParams?.get("all")      ?? "", [searchParams]);
  const isBrandMode    = !!brandFilter;
  const isCategoryMode = !isBrandMode && !!categoryFilter;
  const isAllMode      = !isBrandMode && !isCategoryMode && allFlag === "1";
  const isPickerMode   = !isBrandMode && !isCategoryMode && !isAllMode;
  const scopeLabel     = brandFilter || categoryFilter || (isAllMode ? "Shop all" : "");

  // Signed-in session — feeds `userToken` through to /api/shop-all so the
  // server can blend the user's onboarding taste vector into the ranking.
  // Falls back to empty string for anonymous visitors (server treats "" as
  // "no taste boost" → Algolia + liked-products behaviour, unchanged).
  const { data: session } = useSession();
  const userToken = session?.user?.id ?? "";

  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  // Max price cap (USD). null = no cap. Applied as an Algolia numeric filter
  // server-side and as a lenient post-filter for rows missing a price.
  const [priceMax, setPriceMax] = useState<number | null>(null);
  // Sort mode for the LOADED set (client-side). Doesn't change the fetch
  // order, just re-orders what's already on screen — see SortMode comment.
  const [sortMode, setSortMode] = useState<SortMode>("featured");
  const [products, setProducts] = useState<Product[]>([]);
  const [page, setPage]         = useState(0);
  const [loading, setLoading]   = useState(false);
  const [hasMore, setHasMore]   = useState(true);
  const seenIdsRef              = useRef<Set<string>>(new Set());
  const sentinelRef             = useRef<HTMLDivElement>(null);

  // Display order = server order, optionally re-sorted client-side by price.
  // The brand-mixer that used to wrap this was truncating the grid when a
  // single brand dominated the pool.
  const displayProducts = useMemo(
    () => sortProducts(products, sortMode),
    [products, sortMode],
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

  // Hydrate from localStorage on mount so a returning user's feed already
  // reflects what they responded to last visit. Session-signals persistence
  // is separate from `saved` (shortlist) persistence — these are implicit
  // taste signals, not bookmarks.
  useEffect(() => {
    const persisted = loadSessionSignals();
    if (!persisted) return;
    if (persisted.likedIds.length)        setLikedIds(new Set(persisted.likedIds));
    if (persisted.clickHistory.length)    clickHistoryRef.current    = persisted.clickHistory;
    if (persisted.dislikedSignals.length) dislikedSignalsRef.current = persisted.dislikedSignals;
    if (Object.keys(persisted.dwellTimes).length) setDwellTimes(persisted.dwellTimes);
  }, []);

  // Centralized persist helper — callers (handleLike, handleDwell,
  // handleScrollBack) call this after mutating any of the four signal
  // collections. Internally debounced so rapid updates coalesce into one
  // localStorage write.
  const persistSignals = useCallback(() => {
    saveSessionSignals({
      likedIds,
      clickHistory:    clickHistoryRef.current,
      dislikedSignals: dislikedSignalsRef.current,
      dwellTimes,
    });
  }, [likedIds, dwellTimes]);

  // Flush pending writes on tab-hide / unload so a close doesn't drop the
  // last debounced write. `visibilitychange` fires reliably on iOS where
  // `beforeunload` doesn't; we bind both as belt-and-braces.
  useEffect(() => {
    const onHide = () => flushSessionSignals();
    window.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onHide);
    };
  }, []);

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
    // Merge in shortlist saves as additional "liked" signals. Saves are a
    // stronger, more deliberate preference than in-session likes — and they
    // persist across visits, so a returning user's feed is immediately
    // biased toward what they've collected before. Same byKey aggregation
    // applies on top, so a brand that appears in BOTH session-likes and
    // shortlist-saves ranks above either source alone.
    const liked    = [...clickHistoryRef.current, ...(getShortlistSignals() as ClickSignalLike[])];
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
          bias:            buildBias(),
          likedProductIds: Array.from(likedIds),
          userToken,
          brandFilter:     brandFilter    ?? "",
          categoryFilter:  categoryFilter ?? "",
          priceMax,
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
  }, [page, loading, hasMore, dedupeAgainstSeen, buildBias, brandFilter, categoryFilter, priceMax, steerQuery, steerInterp, isPickerMode, likedIds, userToken]);

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
    // Price cap joins the scope key so changing the cap forces a fresh fetch
    // (same as flipping category / brand / steer). The all-mode flag also
    // joins it: navigating /shop → /shop?all=1 leaves brand+category+steer
    // empty in both, so without including `allFlag` the scope key stays
    // "|||" and initStartedRef would block the fetch — the catalog walk
    // never fires and the user lands on an empty Shop all page.
    const scope = `${brandFilter}|${categoryFilter}|${steerQuery}|${priceMax ?? ""}|${allFlag}`;
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
            page:            0,
            bias:            buildBias(),
            likedProductIds: Array.from(likedIds),
            userToken,
            brandFilter:     brandFilter    ?? "",
            categoryFilter:  categoryFilter ?? "",
            priceMax,
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
  }, [brandFilter, categoryFilter, steerQuery, priceMax, isPickerMode, userToken, allFlag]);

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
    // Trigger on any of: coarse attribute bias, liked product IDs (→ CLIP
    // centroid search on the server). The latter is the stronger signal
    // and alone suffices — one like is enough to refetch.
    const hasLiked = (bias.likedBrands?.length ?? 0) > 0
      || (bias.likedCategories?.length ?? 0) > 0
      || (bias.likedColors?.length ?? 0) > 0
      || likedIds.size > 0;
    if (!hasLiked) return;
    biasRefetchInFlightRef.current = true;
    try {
      const res = await fetch(`/api/shop-all`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          page: 0,
          bias,
          likedProductIds: Array.from(likedIds),
          userToken,
          brandFilter,
          categoryFilter,
          priceMax,
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
  }, [buildBias, brandFilter, categoryFilter, priceMax, steerQuery, steerInterp, isBrandMode, likedIds, userToken]);

  // Toggle-save handler. Saves are a strong, deliberate taste signal:
  //   1. Contribute to the shortlist-derived bias on future /api/shop-all
  //      fetches (via getShortlistSignals in buildBias).
  //   2. Re-rank the upcoming preloaded pool client-side so the next few
  //      cards shift toward similar brand/color/category matches instantly.
  //   3. Fire refreshBiasedAhead to pull a fresh server-biased batch and
  //      splice it in at activeIdx + 2 — same behavior as handleLike.
  //      Saves deserve this treatment: they're more deliberate than likes
  //      (explicit "add to shortlist" tap vs quick double-heart) and the
  //      user expects immediate feedback.
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
      title_en:    product.title_en,
    });
    setSavedIds((prev) => new Set(prev).add(productId));
    setToast("saved to your shortlist");

    // Feed the saved product's attributes into the upcoming-rank signal
    // so cards ahead of the user's position reshuffle toward brand /
    // color / category matches. Capped at 30 like clickHistory so one
    // heavy shortlist session doesn't drown recent likes.
    const signal = productToSignal(product);
    clickHistoryRef.current = [signal, ...clickHistoryRef.current].slice(0, 30);
    setProducts((prev) => {
      const signals: ScoringSignals = {
        likedProductIds: new Set([...Array.from(likedIds), productId]),
        clickHistory:    clickHistoryRef.current,
        dislikedSignals: dislikedSignalsRef.current,
        dwellTimes,
        aestheticPrice:  "mid",
      };
      return reRankUpcomingProducts(prev, activeScrollIdxRef.current, signals);
    });

    // Server refetch with updated bias — splices a fresh batch in at
    // activeIdx + 2 so the next swipe/scroll lands on something the
    // catalog itself thinks matches the new save. Same path as handleLike.
    void refreshBiasedAhead();
    persistSignals();
  }, [products, savedIds, likedIds, dwellTimes, reRankUpcomingProducts, refreshBiasedAhead, persistSignals]);

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
    // Subtle haptic on a new like. Android Chrome supports navigator.vibrate;
    // iOS Safari silently ignores. Guard so SSR and non-Browser paths don't
    // explode. 10 ms is the TikTok-ish "tick" — perceptible, not jarring.
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try { navigator.vibrate(10); } catch { /* some browsers throw; ignore */ }
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
    persistSignals();
  }, [products, likedIds, dwellTimes, reRankUpcomingProducts, refreshBiasedAhead, persistSignals]);

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
    persistSignals();
  }, [products, likedIds, dwellTimes, reRankUpcomingProducts, refreshBiasedAhead, persistSignals]);

  // Scroll-back: the user flicked up to revisit a card they already passed.
  // This is a strong positive — "I thought about this one more" — that's
  // subtler than a like. We add the product's attributes to clickHistory
  // (same shape as a like-derived signal) so affinities boost for upcoming
  // cards, but we don't add it to likedIds (nothing hearted) and we don't
  // trigger a full refetch (cheaper than a like — just a local re-rank).
  // Guard with a per-id dedupe ref so a user who bounces back-and-forth on
  // the same card doesn't spam clickHistory.
  const scrollBackSeenRef = useRef<Set<string>>(new Set());
  const handleScrollBack = useCallback((productId: string) => {
    if (scrollBackSeenRef.current.has(productId)) return;
    scrollBackSeenRef.current.add(productId);
    const product = products.find((p) => p.objectID === productId);
    if (!product) return;
    clickHistoryRef.current = [productToSignal(product), ...clickHistoryRef.current].slice(0, 30);
    setProducts((prev) => {
      const signals: ScoringSignals = {
        likedProductIds: likedIds,
        clickHistory:    clickHistoryRef.current,
        dislikedSignals: dislikedSignalsRef.current,
        dwellTimes,
        aestheticPrice:  "mid",
      };
      return reRankUpcomingProducts(prev, activeScrollIdxRef.current, signals);
    });
    persistSignals();
  }, [products, likedIds, dwellTimes, reRankUpcomingProducts, persistSignals]);

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

    // ── Fast path: parse client-side and apply immediately ────────────────
    // "in black", "cheaper", "no florals", "show me bags" — all handled by
    // a 0-ms regex pass. Triggers the refetch-via-useEffect the instant the
    // user hits enter, no network round-trip to Claude required.
    const fast = fastParseSteerText(trimmed);
    setSteerQuery(trimmed);

    if (fast.isConcrete && !fast.isAbstract) {
      // Concrete-only steer — skip Claude entirely.
      setSteerInterp(fast);
      return;
    }

    // Apply whatever concrete bits we have NOW so the feed updates
    // immediately, then fire Claude to pick up style_axes / nuance.
    if (fast.isConcrete) setSteerInterp(fast);

    setInterpretingSteer(true);
    let rich: SteerInterpretation | null = null;
    try {
      const res = await fetch("/api/steer-interpret", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text: trimmed }),
      });
      if (res.ok) rich = (await res.json()) as SteerInterpretation;
    } catch (err) {
      console.warn("[shop] steer interpret failed:", err);
    }
    setInterpretingSteer(false);

    // If Claude adds style_axes or new concrete fields that the fast parse
    // missed, merge + re-apply. Otherwise leave the fast result in place so
    // we don't trigger a second refetch for nothing.
    if (rich) {
      const merged = mergeSteerResults(fast, rich);
      const addedAxes = Object.keys(rich.style_axes ?? {}).length > 0;
      const addedFields =
        merged.colors.length      > fast.colors.length      ||
        merged.categories.length  > fast.categories.length  ||
        merged.search_terms.length> fast.search_terms.length||
        merged.avoid_terms.length > fast.avoid_terms.length ||
        (rich.price_range != null && rich.price_range !== fast.price_range);
      if (!fast.isConcrete || addedAxes || addedFields) {
        setSteerInterp(merged);
      }
    } else if (!fast.isConcrete) {
      // Claude failed AND fast had nothing — at least drop to a search-term
      // fallback so the user isn't staring at an empty grid forever.
      setSteerInterp({
        ...fast,
        search_terms: trimmed.split(/\s+/).filter(Boolean),
      });
    }
  }, []);

  // Grid view no longer auto-loads via IntersectionObserver. Pagination is
  // now driven by an explicit "Load more" button below the grid (see the
  // render below). The scroll view still has its own near-end auto-load
  // since there's no obvious place for a button in a TikTok-style feed.
  const hasProducts = products.length > 0;

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
          <Link href="/twin"   className="text-muted hover:text-foreground transition-colors">TwinFinder</Link>
          <Link href="/edit"   className="text-muted hover:text-foreground transition-colors">Your shortlist</Link>
        </div>
        <MobileMenu
          variant="cream"
          links={[
            { href: "/shop",      label: "Shop" },
            { href: "/brands",    label: "Brands" },
            { href: "/twin",      label: "TwinFinder" },
            { href: "/edit",      label: "Your shortlist" },
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
                  Shop the Back Catalogue
                </h1>
                <p className="font-sans text-base text-muted-strong max-w-2xl leading-relaxed">
                  Pick a category to browse. Over 100,000 pieces from vintage stores, eco-friendly labels, and small-batch makers.
                </p>
              </>
            )}
          </div>
          {/* "Tailor to your taste" used to live as a separate /dashboard
              page with its own intake (Pinterest / Describe / Upload). It's
              now embedded inline below as <TasteShopFlow /> on every
              category and "Shop all" page, so the standalone CTA is gone. */}
        </div>

        {/* Inline TasteShopFlow — same intake → musing → scroll experience as
            the old /dashboard, but scoped to the page's category. Sits ABOVE
            the default category feed; submitting a search takes over the
            visible area until the user clicks "← Clear search". Pinterest
            tab is hidden for anon users (sign in via the nav to enable). */}
        {(isCategoryMode || isAllMode) && (
          <section className="mb-6 border border-border-mid">
            <TasteShopFlow
              categoryFilter={isCategoryMode ? categoryFilter : undefined}
              callbackUrl={`${pathname}${searchParams?.toString() ? "?" + searchParams.toString() : ""}`}
              allowPinterest={!!userToken}
            />
          </section>
        )}

        {/* Category picker — home view only */}
        {isPickerMode && <CategoryPickerGrid />}

        {/* View toggle + product grid — only in brand/category mode */}
        {!isPickerMode && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-y-5 gap-x-8 mb-10 border-y border-border-mid py-5">
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

              {/* Price cap pills removed — the search bar's PRICE RANGE
                  selector (rendered inside TasteShopFlow above) is now the
                  single source of truth for capping the feed. Two parallel
                  controls confused users about which one applied.
                  priceMax state + plumbing kept so the search-bar selector
                  can still flow through to /api/shop-all. */}

              {/* Sort pills — re-orders the LOADED set client-side. Doesn't
                  alter the catalog walk; "Load more" continues fetching in
                  the catalog's native order and the new batch is folded in
                  via the displayProducts memo. */}
              <div
                role="radiogroup"
                aria-label="Sort order"
                className="flex items-center"
              >
                <span className="font-sans text-[9px] tracking-widest uppercase text-muted-dim mr-4">
                  Sort
                </span>
                <div className="flex">
                  {SORT_OPTIONS.map((opt, i) => {
                    const active = sortMode === opt.value;
                    return (
                      <button
                        key={opt.value}
                        role="radio"
                        aria-checked={active}
                        onClick={() => setSortMode(opt.value)}
                        className={`px-4 py-2.5 font-sans text-[10px] tracking-widest uppercase border ${
                          i === 0 ? "" : "border-l-0"
                        } transition-colors ${
                          active
                            ? "bg-foreground text-background border-foreground"
                            : "border-border-mid text-muted hover:text-foreground hover:border-foreground/60"
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
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
                {/* Load-more button — sits below the grid on every scoped
                    lane (brand, category, or query-driven). Auto-pagination
                    via IntersectionObserver was removed so the user controls
                    when the page grows. Keep the sentinelRef ref around so
                    any lingering sub-components don't blow up; we just
                    stopped pointing anything at it. */}
                {products.length > 0 && (
                  <div ref={sentinelRef} className="flex items-center justify-center mt-12">
                    {hasMore ? (
                      <button
                        type="button"
                        onClick={loadMore}
                        disabled={loading}
                        className="px-8 py-3.5 border border-border-mid text-foreground font-sans text-[10px] tracking-widest uppercase hover:border-foreground hover:bg-foreground hover:text-background transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {loading ? "Loading…" : "Load more →"}
                      </button>
                    ) : (
                      <p className="font-display italic text-lg text-muted">
                        That&apos;s everything in {scopeLabel}.
                      </p>
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
          onScrollBack={handleScrollBack}
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
            alt={displayTitle(product)}
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
          {displayTitle(product)}
        </p>
        <div className="flex items-center justify-between">
          {product.price != null ? (
            <span className="font-sans text-xs font-medium text-foreground">{formatPrice(product.price)}</span>
          ) : <span />}
          {/* Always-visible Shop affordance with a subtle underline so users
              don't miss that the whole card is a buy link to the brand site. */}
          <span className="font-sans text-[9px] tracking-widest uppercase text-foreground border-b border-foreground/40 pb-px group-hover:border-accent group-hover:text-accent transition-colors">Shop →</span>
        </div>
      </div>
    </a>
  );
}

// ── Category picker ──────────────────────────────────────────────────────────
// Home-view /shop: 7 category tiles, same visual pattern as /brands cards.
// Clicking a tile deep-links to /shop?category=NAME which switches this same
// page into category-scope product mode.

// "Shop all" is rendered first so it's the most prominent tile — clicking
// it lands on /shop?all=1 which bypasses the category scope and walks the
// full catalog. Renders as a blank cream card (no hero image, no count
// badge) so it reads as a deliberate "everything" entry rather than
// pretending to feature a single product.
const CATEGORY_LABELS = [
  "Shop all",
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
  // "Shop all" is a special tile: blank cream card, no hero image, no count
  // badge, and a different deep-link (?all=1 instead of ?category=…). The
  // rest of the tiles fall through to the normal image-with-gradient layout.
  const isShopAll = label === "Shop all";
  const href      = isShopAll ? "/shop?all=1" : `/shop?category=${encodeURIComponent(label)}`;
  const src       = isShopAll ? null : (sample?.imageUrl ?? null);

  if (isShopAll) {
    return (
      <Link
        href={href}
        className="group relative aspect-[3/4] overflow-hidden bg-background border border-border shadow-card hover:shadow-card-hover hover:border-border-mid transition-all duration-300 flex flex-col items-center justify-center text-center"
      >
        <h3 className="font-display font-light text-2xl text-foreground leading-tight">
          {label}
        </h3>
        <p className="font-sans text-[9px] tracking-widest uppercase text-muted mt-3">
          Browse everything
        </p>
      </Link>
    );
  }

  return (
    <Link
      href={href}
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
  likedIds, onLike, onDwell, onScrollBack, onActiveChange,
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
  onScrollBack:   (productId: string) => void;
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

  // Dwell tracking: the timestamp the current "dominant" card became
  // dominant. On transition we fire onDwell with (now - this) — the actual
  // in-viewport time, not the scroll-snap index-change time.
  const cardEnteredAt = useRef<number>(Date.now());
  const prevIdxRef    = useRef<number>(0);
  // High-water mark of cards advanced past. If the user lands on an index
  // below this, that's a deliberate scroll-back — fire `onScrollBack`.
  const maxIdxRef = useRef<number>(0);

  useEffect(() => { nearEndFired.current = false; }, [products.length]);

  // IntersectionObserver-based active-card tracking. Replaces the prior
  // scroll-index math which (a) ran on every scroll event (60fps-ish) and
  // (b) conflated "card on screen" with "card most visible". The observer
  // wakes only when intersection thresholds cross, and picks the card with
  // the highest intersection ratio as the dominant one — a card at 70%
  // visible beats a card at 20% even if the rounded scroll index says
  // otherwise. Dwell times reported here are genuine in-viewport time.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || products.length === 0) return;

    const visRatio = new Map<number, number>();
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const idx = Number((e.target as HTMLElement).dataset.cardIndex);
        if (Number.isFinite(idx)) visRatio.set(idx, e.intersectionRatio);
      }
      // Require >50% visibility to be "dominant". Prevents flash-transitions
      // mid-scroll when two cards straddle the viewport nearly evenly.
      let bestIdx = -1, bestRatio = 0.5;
      for (const [idx, r] of Array.from(visRatio.entries())) {
        if (r > bestRatio) { bestIdx = idx; bestRatio = r; }
      }
      if (bestIdx === -1 || bestIdx === prevIdxRef.current) return;

      // Leave-event for the card we're exiting: real visible time.
      const leaving = products[prevIdxRef.current];
      if (leaving) onDwell(leaving.objectID, Date.now() - cardEnteredAt.current);

      // Scroll-back detection: jumping backward to a card already passed.
      if (bestIdx < prevIdxRef.current && bestIdx < maxIdxRef.current) {
        const revisited = products[bestIdx];
        if (revisited) onScrollBack(revisited.objectID);
      }
      if (bestIdx > maxIdxRef.current) maxIdxRef.current = bestIdx;

      cardEnteredAt.current = Date.now();
      prevIdxRef.current    = bestIdx;
      setActiveIdx(bestIdx);
      onActiveChange(bestIdx);
      if (!nearEndFired.current && hasMore && bestIdx >= products.length - 6) {
        nearEndFired.current = true;
        onNearEnd();
      }
    }, {
      root:       container,
      // Multiple thresholds so we get fine-grained ratio updates, not just
      // a binary in/out event. 25/50/75/100 is plenty for a snap-scroller.
      threshold: [0, 0.25, 0.5, 0.75, 1],
    });

    const cards = container.querySelectorAll<HTMLElement>("[data-card-index]");
    cards.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [products, hasMore, onNearEnd, onDwell, onScrollBack, onActiveChange]);

  // Wheel → snap by viewport height. Tuned for a TikTok-like snappy feel:
  //   - delta threshold 144 px ignores micro-flicks, fires on small flicks
  //   - cooldown 700 ms (was 1280) — consecutive snaps feel near-instant
  //     to a power user without losing the "one flick = one card" invariant
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
      setTimeout(() => { isScrolling.current = false; }, 700);
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
        // Matches the wheel cooldown so keyboard and wheel snap at the same pace.
        setTimeout(() => { isScrolling.current = false; }, 600);
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

  // Double-tap to like: fires the same `onLike` path as the heart button,
  // plus a transient heart-pulse animation on the tapped card. `pulseProductId`
  // holds the id for ~600 ms so the CSS `animate-ping` can play, then clears.
  const [pulseProductId, setPulseProductId] = useState<string | null>(null);
  const handleDoubleTap = useCallback((productId: string) => {
    // Don't toggle-off on double-tap — double-tap is an additive "I like this"
    // gesture. The user can un-like via the heart button if they want.
    if (!likedIds.has(productId)) onLike(productId);
    setPulseProductId(productId);
    window.setTimeout(() => {
      // Only clear if this id is still the pulsing one (avoid race with a
      // second double-tap on a different card).
      setPulseProductId((prev) => (prev === productId ? null : prev));
    }, 650);
  }, [likedIds, onLike]);

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
            className="no-scrollbar w-full h-full sm:w-[440px] sm:max-w-[92vw] sm:h-[88vh] overflow-y-scroll overflow-x-hidden bg-background shadow-2xl"
            style={{ scrollSnapType: "y mandatory" }}
          >
            {products.map((p, i) => (
              <ProductScrollCard
                key={p.objectID}
                product={p}
                index={i}
                activeIdx={activeIdx}
                onDoubleTap={handleDoubleTap}
                showLikedPulse={pulseProductId === p.objectID}
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
  product, index, activeIdx, onDoubleTap, showLikedPulse,
}: {
  product:   Product;
  index:     number;
  activeIdx: number;
  onDoubleTap?: (productId: string) => void;
  showLikedPulse?: boolean;
}) {
  // Preload window widened from ±2 → ±4 so fast swipes land on decoded images
  // instead of briefly empty cards. Bandwidth cost is minimal at 440 px card
  // width; perceptual-latency win is significant on a TikTok-style flick.
  const isNear = Math.abs(index - activeIdx) <= 4;

  // Double-tap to like. Classic TikTok gesture: two quick taps on the image
  // fire `onDoubleTap`, a single tap falls through to the anchor navigation.
  // We track a tap-count ref and a timer — on the second tap inside 300 ms
  // we prevent the anchor default and call the handler.
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<number | null>(null);
  const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!onDoubleTap) return; // no handler → normal click-through
    tapCountRef.current += 1;
    if (tapCountRef.current === 1) {
      // Start the double-tap window. If a second tap doesn't land, the first
      // tap stays as a regular navigation — we don't preventDefault here,
      // so the browser follows the anchor on the original click.
      tapTimerRef.current = window.setTimeout(() => {
        tapCountRef.current = 0;
        tapTimerRef.current = null;
      }, 300);
      return;
    }
    // Second tap inside the window → this is a like, not a navigation.
    e.preventDefault();
    if (tapTimerRef.current != null) {
      window.clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    }
    tapCountRef.current = 0;
    onDoubleTap(product.objectID);
  }, [onDoubleTap, product.objectID]);

  return (
    <a
      href={product.product_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className="relative flex flex-col bg-background block"
      style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}
      data-card-index={index}
    >
      {/* Full-bleed image fills the card */}
      <div className="absolute inset-0 bg-[rgba(42,51,22,0.04)]">
        {product.image_url ? (
          <Image
            src={product.image_url}
            alt={displayTitle(product)}
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

      {/* Double-tap heart pulse — appears briefly on successful double-tap.
          Purely decorative; the actual state change happens in onLike. */}
      {showLikedPulse && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <svg viewBox="0 0 24 24" className="w-28 h-28 text-white/90 animate-[ping_0.6s_ease-out]" fill="currentColor" stroke="none">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </div>
      )}

      {/* Bottom overlay — brand, title, price, shop */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-5 py-6 bg-gradient-to-t from-background via-background/85 to-transparent">
        {product.brand && <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1">{product.brand}</p>}
        <p className="font-display font-light text-xl text-foreground leading-snug mb-1 break-words">{displayTitle(product)}</p>
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
