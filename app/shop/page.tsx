"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { algoliasearch } from "algoliasearch";

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

// ── Constants ─────────────────────────────────────────────────────────────────

const HITS_PER_PAGE = 48;
const INDEX_NAME    = "vitrine_products";

function formatPrice(p: number | null): string {
  if (p == null) return "";
  return `$${Math.round(p).toLocaleString("en-US")}`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ShopPage() {
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [products, setProducts] = useState<Product[]>([]);
  const [page, setPage]         = useState(0);
  const [loading, setLoading]   = useState(false);
  const [hasMore, setHasMore]   = useState(true);
  const sentinelRef             = useRef<HTMLDivElement>(null);

  const client = useMemo(() => algoliasearch(
    process.env.NEXT_PUBLIC_ALGOLIA_APP_ID!,
    process.env.NEXT_PUBLIC_ALGOLIA_SEARCH_KEY!,
  ), []);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const res = await client.searchSingleIndex({
        indexName: INDEX_NAME,
        searchParams: {
          query:                "",
          hitsPerPage:          HITS_PER_PAGE,
          page,
          attributesToRetrieve: ["objectID", "title", "brand", "retailer", "price", "image_url", "product_url"],
        },
      });
      const fresh = (res.hits ?? []) as unknown as Product[];
      // Filter out products with missing or non-http image URLs — those are the
      // broken-URL stragglers the embed pipeline surfaces. Not worth showing.
      const clean = fresh.filter((p) => typeof p.image_url === "string" && p.image_url.startsWith("http"));
      setProducts((prev) => [...prev, ...clean]);
      setPage((p) => p + 1);
      if (fresh.length < HITS_PER_PAGE) setHasMore(false);
    } catch (err) {
      console.error("[shop] load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [client, page, loading, hasMore]);

  // initial load
  useEffect(() => { loadMore(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

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
            <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">The catalog</p>
            <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight mb-4">
              Shop all
            </h1>
            <p className="font-sans text-base text-muted-strong max-w-2xl leading-relaxed">
              Over 100,000 pieces from vintage stores, eco-friendly labels, and small-batch makers.
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

        {/* Scroll view */}
        {viewMode === "scroll" && (
          <ProductScroll products={products} onNearEnd={loadMore} loading={loading} hasMore={hasMore} />
        )}
      </main>

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

// ── Scroll view ───────────────────────────────────────────────────────────────

function ProductScroll({
  products, onNearEnd, loading, hasMore,
}: {
  products: Product[]; onNearEnd: () => void; loading: boolean; hasMore: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isScrolling  = useRef(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const nearEndFired = useRef(false);

  // One-card-at-a-time scroll snap + active index tracking
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

  // Reset near-end flag whenever more products arrive
  useEffect(() => { nearEndFired.current = false; }, [products.length]);

  // Wheel → smooth snap by viewport height
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (isScrolling.current) return;
      isScrolling.current = true;
      el.scrollBy({ top: Math.sign(e.deltaY) * el.clientHeight, behavior: "smooth" });
      setTimeout(() => { isScrolling.current = false; }, 800);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Arrow-key nav
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="w-full overflow-y-scroll bg-background"
      style={{ height: "calc(100vh - 6rem)", scrollSnapType: "y mandatory" }}
    >
      <span className="fixed bottom-6 right-8 z-40 font-sans text-[9px] tracking-widest uppercase text-muted bg-background/80 backdrop-blur-sm px-3 py-1.5 border border-border pointer-events-none">
        {Math.min(activeIdx + 1, products.length)} / {products.length}
      </span>
      {products.map((p, i) => (
        <div
          key={p.objectID}
          className="w-full flex items-center justify-center"
          style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}
        >
          <ScrollCard product={p} active={i === activeIdx} />
        </div>
      ))}
      {loading && (
        <div className="w-full flex items-center justify-center bg-background" style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}>
          <p className="font-display italic text-xl text-muted">Loading more…</p>
        </div>
      )}
      {!hasMore && (
        <div className="w-full flex items-center justify-center bg-background" style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}>
          <p className="font-display italic text-xl text-muted">That&apos;s everything.</p>
        </div>
      )}
    </div>
  );
}

function ScrollCard({ product, active }: { product: Product; active: boolean }) {
  return (
    <div className="max-w-md w-full px-8">
      <div className="aspect-[3/4] relative overflow-hidden bg-[rgba(42,51,22,0.04)] shadow-card mb-5">
        {product.image_url && (
          <Image
            src={product.image_url}
            alt={product.title}
            fill
            unoptimized
            priority={active}
            className="object-cover object-top"
            sizes="(max-width: 640px) 90vw, 448px"
          />
        )}
      </div>
      <p className="font-sans text-[10px] tracking-widest uppercase text-accent mb-2">{product.brand}</p>
      <p className="font-display font-light text-xl text-foreground leading-snug mb-3">{product.title}</p>
      <div className="flex items-center justify-between">
        {product.price != null ? (
          <span className="font-sans text-sm text-foreground">{formatPrice(product.price)}</span>
        ) : <span />}
        <a
          href={product.product_url || "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="font-sans text-[10px] tracking-widest uppercase text-foreground hover:text-accent transition-colors"
        >
          Shop →
        </a>
      </div>
    </div>
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
