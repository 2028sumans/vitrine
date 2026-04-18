"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Product {
  objectID:     string;
  title:        string;
  brand:        string;
  retailer?:    string;
  price:        number | null;
  image_url:    string;
  product_url:  string;
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

  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [products, setProducts] = useState<Product[]>([]);
  const [page, setPage]         = useState(0);
  const [loading, setLoading]   = useState(false);
  const [hasMore, setHasMore]   = useState(true);
  // When true, the feed is from /api/shop-personalized (Pinterest-biased) and
  // pagination is disabled (results are the full 120 most-similar products).
  const [personalized, setPersonalized]   = useState(false);
  const [personalizing, setPersonalizing] = useState(false);
  const [fashionBoardCount, setFashionBoardCount] = useState(0);
  const sentinelRef             = useRef<HTMLDivElement>(null);
  const personalizeTriedRef     = useRef(false);

  // Fallback path — the flat, interleaved catalog walk.
  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/shop-all?page=${page}`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("[shop] non-ok:", res.status, body);
        setHasMore(false);
        return;
      }
      const data  = await res.json();
      const fresh = (data.products ?? []) as Product[];
      setProducts((prev) => [...prev, ...fresh]);
      setPage((p) => p + 1);
      if (!data.hasMore) setHasMore(false);
    } catch (err) {
      console.error("[shop] load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [page, loading, hasMore]);

  // Personalized path — fetch fashion boards → embed → Pinecone similarity.
  // Replaces the flat feed when successful.
  const tryPersonalize = useCallback(async (token: string) => {
    if (personalizeTriedRef.current) return false;
    personalizeTriedRef.current = true;
    setPersonalizing(true);
    try {
      const boardsRes = await fetch("/api/pinterest/fashion-boards", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!boardsRes.ok) return false;
      const boardsData = await boardsRes.json();
      const pinImageUrls: string[] = boardsData?.pinImageUrls ?? [];
      const fbCount: number       = boardsData?.fashionBoards ?? 0;
      setFashionBoardCount(fbCount);
      if (pinImageUrls.length === 0) return false;

      const shopRes = await fetch("/api/shop-personalized", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ pinImageUrls }),
      });
      if (!shopRes.ok) return false;
      const shopData = await shopRes.json();
      const fresh: Product[] = shopData?.products ?? [];
      if (fresh.length === 0) return false;

      setProducts(fresh);
      setPersonalized(true);
      setHasMore(false); // personalized feed is a single ranked list
      return true;
    } catch (err) {
      console.warn("[shop] personalize failed, falling back:", err);
      return false;
    } finally {
      setPersonalizing(false);
    }
  }, []);

  // Initial load: if a Pinterest token is available, try personalized first;
  // fall back to the flat catalog walk if it returns nothing.
  useEffect(() => {
    // Wait until the session has resolved before deciding
    if (session === undefined) return;
    if (accessToken) {
      (async () => {
        const ok = await tryPersonalize(accessToken);
        if (!ok && products.length === 0) loadMore();
      })();
    } else if (products.length === 0) {
      loadMore();
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [session, accessToken]);

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
            <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4 flex items-center gap-3">
              <span>The catalog</span>
              {personalizing && (
                <span className="text-accent normal-case tracking-normal font-display italic text-sm">
                  reading your pinterest…
                </span>
              )}
              {personalized && !personalizing && (
                <span className="text-accent normal-case tracking-normal font-display italic text-sm">
                  ranked from your pinterest
                  {fashionBoardCount > 0 ? ` (${fashionBoardCount} board${fashionBoardCount === 1 ? "" : "s"})` : ""}
                </span>
              )}
            </p>
            <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight mb-4">
              Shop all
            </h1>
            <p className="font-sans text-base text-muted-strong max-w-2xl leading-relaxed">
              {personalized
                ? "Everything in our catalog, ranked by visual similarity to your fashion boards. Pinecone-sorted by your taste."
                : "Over 100,000 pieces from vintage stores, eco-friendly labels, and small-batch makers."}
            </p>
          </div>
          <Link
            href="/dashboard"
            className="inline-block self-start sm:self-end px-6 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200 whitespace-nowrap"
          >
            Tailor to your taste →
          </Link>
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
}: {
  products: Product[];
  onNearEnd: () => void;
  loading:   boolean;
  hasMore:   boolean;
  onClose:   () => void;
}) {
  const router        = useRouter();
  const containerRef  = useRef<HTMLDivElement>(null);
  const isScrolling   = useRef(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const nearEndFired  = useRef(false);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, clientHeight } = containerRef.current;
    const idx = Math.round(scrollTop / clientHeight);
    setActiveIdx(idx);
    if (!nearEndFired.current && hasMore && idx >= products.length - 6) {
      nearEndFired.current = true;
      onNearEnd();
    }
  }, [products.length, hasMore, onNearEnd]);

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

  // Steer submit → route to /dashboard with the comment as ?describe=…
  const handleSteer = useCallback((comment: string) => {
    router.push(`/dashboard?describe=${encodeURIComponent(comment)}`);
  }, [router]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop — blurred view of the grid behind */}
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute inset-0 bg-background/40 backdrop-blur-md cursor-default"
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

      {/* Narrow centered scroll column */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="relative z-10 w-[440px] max-w-[92vw] h-[88vh] overflow-y-scroll bg-background shadow-2xl"
        style={{ scrollSnapType: "y mandatory" }}
      >
        {products.map((p, i) => (
          <ProductScrollCard
            key={p.objectID}
            product={p}
            index={i}
            activeIdx={activeIdx}
            onSayMore={handleSteer}
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
    </div>
  );
}

// ── Scroll card — full-bleed image in the column, buttons on right edge ──────

function ProductScrollCard({
  product, index, activeIdx, onSayMore,
}: {
  product:    Product;
  index:      number;
  activeIdx:  number;
  onSayMore?: (comment: string) => void;
}) {
  const isNear = Math.abs(index - activeIdx) <= 2;
  const [liked, setLiked]             = useState(false);
  const [showSayMore, setShowSayMore] = useState(false);
  const [sayMoreText, setSayMoreText] = useState("");

  const handleLike = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLiked((l) => !l);
  };

  const handleSayMoreSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const trimmed = sayMoreText.trim();
    if (trimmed) {
      onSayMore?.(trimmed);
      setSayMoreText("");
      setShowSayMore(false);
    }
  };

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
            sizes="440px"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted/20 font-display text-6xl">▢</div>
        )}
      </div>

      {/* Brand label top-left */}
      {product.brand && (
        <div className="absolute top-6 left-5 z-10 pointer-events-none">
          <span className="font-sans text-[9px] tracking-widest uppercase text-foreground/70">{product.brand}</span>
        </div>
      )}

      {/* Right-edge rail: Like + Steer */}
      <div className="absolute right-4 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-5">
        <button onClick={handleLike} className="flex flex-col items-center gap-1.5 active:scale-90 transition-transform" aria-label={liked ? "Unlike" : "Like"}>
          <div className="w-14 h-14 rounded-full bg-black flex items-center justify-center shadow-lg">
            <svg viewBox="0 0 24 24" className="w-[26px] h-[26px]"
              fill={liked ? "#FF2D55" : "none"}
              stroke={liked ? "#FF2D55" : "white"}
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
          </div>
          <span className="font-sans text-[11px] font-semibold text-white" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}>
            {liked ? "Liked" : "Like"}
          </span>
        </button>

        {onSayMore && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowSayMore((v) => !v); }}
            className="flex flex-col items-center gap-1.5 active:scale-90 transition-transform"
            aria-label="Steer"
          >
            <div className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors duration-150 shadow-lg ${showSayMore ? "bg-white" : "bg-black"}`}>
              <svg viewBox="0 0 24 24" className="w-[26px] h-[26px]"
                fill="none"
                stroke={showSayMore ? "black" : "white"}
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <span className="font-sans text-[11px] font-semibold text-white" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}>
              {showSayMore ? "Cancel" : "Steer"}
            </span>
          </button>
        )}
      </div>

      {/* Say-more input */}
      {showSayMore && (
        <form
          onSubmit={handleSayMoreSubmit}
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-28 left-3 right-3 z-30"
        >
          <div className="flex gap-2">
            <input
              autoFocus
              value={sayMoreText}
              onChange={(e) => setSayMoreText(e.target.value)}
              placeholder="more minimalist… no florals… show me bags…"
              className="flex-1 bg-background/95 backdrop-blur-sm border border-border-mid px-3 py-2 font-sans text-xs text-foreground placeholder-muted focus:outline-none focus:border-foreground/60"
            />
            <button type="submit" className="px-3 py-2 bg-foreground text-background font-sans text-[9px] tracking-widest uppercase whitespace-nowrap">→</button>
          </div>
        </form>
      )}

      {/* Bottom overlay — brand, title, price, shop */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-5 py-6 bg-gradient-to-t from-background via-background/85 to-transparent">
        {product.brand && <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1">{product.brand}</p>}
        <p className="font-display font-light text-xl text-foreground leading-snug mb-1">{product.title}</p>
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
