"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useSession } from "next-auth/react";
import {
  rankCards,
  interpretDwell,
  type ScoringSignals,
  type ClickSignalLike,
  type ScoringCard,
} from "@/lib/scoring";

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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ShopPage() {
  const { data: session } = useSession();
  const accessToken = (session as { accessToken?: string } | null)?.accessToken;

  // If the user arrived from /brands via a brand card, scope everything to
  // that brand. Starts as null (not yet read from URL) so the initial-load
  // effect can wait until we know which mode we're in before firing a fetch.
  const [brandFilter, setBrandFilter] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") { setBrandFilter(""); return; }
    setBrandFilter(new URLSearchParams(window.location.search).get("brand") ?? "");
  }, []);
  const isBrandMode = !!brandFilter;

  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [products, setProducts] = useState<Product[]>([]);
  const [page, setPage]         = useState(0);
  const [loading, setLoading]   = useState(false);
  const [hasMore, setHasMore]   = useState(true);
  // Pinterest-biased products the 7:3 interleaver can draw from. Collected
  // once on mount (if the user is signed in). Empty pool = no blending happens.
  const [personalizing, setPersonalizing] = useState(false);
  const [fashionBoardCount, setFashionBoardCount] = useState(0);
  const personalizedPoolRef   = useRef<Product[]>([]);
  const personalizedIdxRef    = useRef(0);
  const seenIdsRef            = useRef<Set<string>>(new Set());
  const sentinelRef           = useRef<HTMLDivElement>(null);
  const personalizeTriedRef   = useRef(false);

  // Free-text Steer query from the scroll view. When the user types something
  // like "black only" in the Steer input, we apply it as an Algolia text query
  // (with optionalWords so it ranks rather than strictly filters) over the
  // current scope — brand if we're in brand mode, full catalog otherwise.
  // Empty string = no steer active.
  const [steerQuery, setSteerQuery] = useState<string>("");

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

  // Interleaves a flat batch with the personalized pool at 7:3 ratio. For
  // every 10 output slots we emit 7 from the flat batch then 3 from the pool.
  // Dedupes across everything seen so far (so a product can't appear twice).
  const interleaveWithPool = useCallback((flat: Product[]): Product[] => {
    const pool      = personalizedPoolRef.current;
    const seen      = seenIdsRef.current;
    const out: Product[] = [];
    let flatI = 0;
    while (flatI < flat.length) {
      // 7 from flat
      for (let i = 0; i < 7 && flatI < flat.length; ) {
        const p = flat[flatI++];
        if (seen.has(p.objectID)) continue;
        seen.add(p.objectID);
        out.push(p);
        i++;
      }
      // 3 from personalized pool (if any left)
      for (let i = 0; i < 3 && personalizedIdxRef.current < pool.length; ) {
        const p = pool[personalizedIdxRef.current++];
        if (seen.has(p.objectID)) continue;
        seen.add(p.objectID);
        out.push(p);
        i++;
      }
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

  // Catalog fetch — each page is biased by the session's current signals.
  // No signals = 8-slice flat walk. Signals = taste-query over the full
  // 100K catalog. Pinterest pool still interleaves at 7:3 on top.
  // If a Steer query is active it's sent along and the server folds it
  // into the Algolia search as optionalWords.
  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/shop-all`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ page, bias: buildBias(), brandFilter: brandFilter ?? "", steerQuery }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("[shop] non-ok:", res.status, body);
        setHasMore(false);
        return;
      }
      const data  = await res.json();
      const fresh = (data.products ?? []) as Product[];
      const batch = interleaveWithPool(fresh);
      setProducts((prev) => [...prev, ...batch]);
      setPage((p) => p + 1);
      if (!data.hasMore) setHasMore(false);
    } catch (err) {
      console.error("[shop] load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [page, loading, hasMore, interleaveWithPool, buildBias, brandFilter, steerQuery]);

  // Fetch the user's fashion-board pin URLs → embed → Pinecone similarity →
  // store as a pool. Pool is then drawn from by interleaveWithPool at 30%.
  const tryPersonalize = useCallback(async (token: string) => {
    if (personalizeTriedRef.current) return;
    personalizeTriedRef.current = true;
    setPersonalizing(true);
    try {
      const boardsRes = await fetch("/api/pinterest/fashion-boards", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!boardsRes.ok) return;
      const boardsData = await boardsRes.json();
      const pinImageUrls: string[] = boardsData?.pinImageUrls ?? [];
      setFashionBoardCount(boardsData?.fashionBoards ?? 0);
      if (pinImageUrls.length === 0) return;

      const shopRes = await fetch("/api/shop-personalized", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ pinImageUrls, brandFilter: brandFilter ?? "" }),
      });
      if (!shopRes.ok) return;
      const shopData = await shopRes.json();
      const pool: Product[] = shopData?.products ?? [];
      if (pool.length === 0) return;

      // Only record the pool — existing flat products stay in place.
      personalizedPoolRef.current = pool;
      personalizedIdxRef.current  = 0;
    } catch (err) {
      console.warn("[shop] personalize failed, falling back to flat feed:", err);
    } finally {
      setPersonalizing(false);
    }
  }, []);

  // Initial load AND Steer-driven reload. Waits until (a) the session has
  // resolved and (b) we've read the ?brand=… URL param. Re-fires whenever
  // steerQuery changes — the Steer submit handler below wipes products
  // first, so this then re-populates them against the new query.
  // In brand mode the Pinterest pool gets filtered to just that brand on
  // the server side so it still biases toward your taste without leaking
  // other brands in.
  useEffect(() => {
    if (session === undefined) return;
    if (brandFilter === null) return;
    if (products.length === 0) loadMore();
    if (accessToken) void tryPersonalize(accessToken);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [session, accessToken, brandFilter, steerQuery]);

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
        body:    JSON.stringify({ page: 0, bias, brandFilter, steerQuery }),
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
  }, [buildBias, brandFilter, steerQuery, isBrandMode]);

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

  // Steer submit from inside the scroll view. Resets products/page/seen so
  // the initial-load useEffect (which depends on steerQuery) refires and
  // re-populates the feed against the new query. An empty comment clears
  // the steer back out. IMPORTANT: never navigate away — the user is in
  // a specific context (brand or flat) and wants to refine it in place,
  // not be kicked to /dashboard.
  const handleSteer = useCallback((comment: string) => {
    const trimmed = comment.trim();
    // Reset the feed state; initial-load effect will re-fetch with the
    // new steerQuery. Keep clickHistory / likedIds / disliked refs so
    // session-accumulated bias still applies on top of the steer query.
    setProducts([]);
    setPage(0);
    setHasMore(true);
    setLoading(false);
    seenIdsRef.current = new Set();
    personalizedIdxRef.current = 0;
    setSteerQuery(trimmed);
  }, []);

  // infinite scroll sentinel (grid only — scroll mode has its own logic)
  useEffect(() => {
    if (viewMode !== "grid") return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadMore();
    }, { rootMargin: "600px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewMode, loadMore]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav — matches /brands + homepage cream-olive */}
      <header className="fixed top-0 left-0 right-0 z-50 px-8 py-2.5 bg-background/80 backdrop-blur-sm flex items-center justify-between">
        <Link href="/" className="font-display font-light text-base tracking-[0.22em] text-foreground hover:opacity-80 transition-opacity">
          MUSE
        </Link>
        <div className="flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase">
          <Link href="/shop"   className="text-foreground hover:text-accent transition-colors">Shop</Link>
          <Link href="/brands" className="text-muted hover:text-foreground transition-colors">Brands</Link>
          <Link href="/dashboard" className="text-muted hover:text-foreground transition-colors">Tailor to my taste →</Link>
        </div>
      </header>

      <main className="flex-1 pt-20 pb-24 px-8 max-w-7xl mx-auto w-full">
        {/* Header + refine CTA */}
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
            ) : (
              <>
                <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4 flex items-center gap-3">
                  <span>The catalog</span>
                  {personalizing && (
                    <span className="text-accent normal-case tracking-normal font-display italic text-sm">
                      reading your pinterest…
                    </span>
                  )}
                  {!personalizing && fashionBoardCount > 0 && personalizedPoolRef.current.length > 0 && (
                    <span className="text-accent normal-case tracking-normal font-display italic text-sm">
                      30% blended from your pinterest
                      {` (${fashionBoardCount} board${fashionBoardCount === 1 ? "" : "s"})`}
                    </span>
                  )}
                </p>
                <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight mb-4">
                  Shop all
                </h1>
                <p className="font-sans text-base text-muted-strong max-w-2xl leading-relaxed">
                  Over 100,000 pieces from vintage stores, eco-friendly labels, and small-batch makers.
                </p>
              </>
            )}
          </div>
          {!isBrandMode && (
            <Link
              href="/dashboard"
              className="inline-block self-start sm:self-end px-6 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200 whitespace-nowrap"
            >
              Tailor to your taste →
            </Link>
          )}
        </div>

        {/* Prominent view toggle */}
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

        {/* Grid */}
        {viewMode === "grid" && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5">
              {products.map((p) => <GridTile key={p.objectID} product={p} />)}
            </div>
            <div ref={sentinelRef} className="h-24 flex items-center justify-center mt-10">
              {loading && <p className="font-display italic text-lg text-muted">Loading more…</p>}
              {!hasMore && products.length > 0 && (
                <p className="font-display italic text-lg text-muted">That&apos;s everything.</p>
              )}
            </div>
          </>
        )}

      </main>

      {/* Scroll view — modal overlay with a single narrow centered column */}
      {viewMode === "scroll" && (
        <ProductScrollView
          products={products}
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
        />
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
  return (
    <a
      href={product.product_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="group block border border-border hover:border-border-mid bg-background shadow-card hover:shadow-card-hover transition-all duration-300"
    >
      <div className="aspect-[3/4] relative overflow-hidden bg-[rgba(42,51,22,0.04)]">
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
        <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-background/80 to-transparent">
          <p className="font-sans text-[9px] tracking-widest uppercase text-foreground/60">{product.retailer ?? product.brand}</p>
        </div>
      </div>
      <div className="p-3 border-t border-border">
        {product.brand && product.brand.toLowerCase() !== (product.retailer ?? "").toLowerCase() && (
          <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1">{product.brand}</p>
        )}
        <p className="font-sans text-xs text-foreground leading-snug line-clamp-2 mb-2">{product.title}</p>
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

// ── Scroll view — modal overlay, narrow centered scroll column ───────────────
// Matches the dashboard tailored-page scroll exactly: dimmed/blurred page
// backdrop, single column of product cards (~440px wide) centered on screen,
// each card has a full-bleed image with Like + Steer buttons pinned to its
// right edge and brand/title/price overlaid at the bottom.

function ProductScrollView({
  products, onNearEnd, loading, hasMore, onClose,
  likedIds, onLike, onDwell, onActiveChange,
  onSteer, steerQuery,
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

  // Wheel → snap by viewport height, but half as sensitive:
  //   - accumulates wheel delta and only advances after the user has scrolled
  //     ~180 px total (filters out trackpad micro-flicks)
  //   - cooldown bumped 800 ms → 1600 ms so at most one advance per ~1.6 s
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
      if (Math.abs(deltaAccum) < 180) return;
      isScrolling.current = true;
      const direction = Math.sign(deltaAccum);
      deltaAccum = 0;
      el.scrollBy({ top: direction * el.clientHeight, behavior: "smooth" });
      setTimeout(() => { isScrolling.current = false; }, 1600);
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
            className="w-full h-full sm:w-[440px] sm:max-w-[92vw] sm:h-[88vh] overflow-y-scroll overflow-x-hidden bg-background shadow-2xl"
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
