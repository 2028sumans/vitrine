"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSession, signOut, signIn } from "next-auth/react";
import type { StyleDNA } from "@/lib/ai";
import { displayTitle, type AlgoliaProduct, type CategoryCandidates } from "@/lib/algolia";
import { getUserToken, trackProductClick, trackProductsViewed } from "@/lib/insights";
import type { QuestionnaireAnswers, VisionImage } from "@/lib/types";
import { addSaved, removeSaved, isSaved, getShortlistSummary } from "@/lib/saved";
import {
  rankCards,
  type ScoringSignals,
  type ScoringCard,
  type ClickSignalLike,
} from "@/lib/scoring";
import { fastParseSteerText } from "@/lib/steer-fast-parse";
import type { SteerInterpretation as SteerInterp } from "@/lib/steer-interpret";
import { PriceFilterBar, useFilteredByPrice, type PriceTier } from "@/components/price-filter";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a numeric price as "$1,481" with thousand separators. */
function formatPrice(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Board    = { id: string; name: string };
type Step     = "boards" | "shopping_loading" | "shopping" | "error";
type ViewMode = "grid" | "scroll";
type InputMode = "pinterest" | "text" | "images" | "quiz";

interface PinData {
  id:          string;
  title:       string;
  description: string;
  imageUrl:    string;
  thumbUrl:    string;
  altText?:    string;
  link?:       string;
  domain?:     string;
  dominantColors?: string[];
}

// ── Color → CSS ───────────────────────────────────────────────────────────────

function colorToCSS(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("ivory") || n.includes("off-white") || n.includes("oatmeal")) return "#FAF3E0";
  if (n.includes("cream"))  return "#FFF8DC";
  if (n.includes("white"))  return "#F8F8F0";
  if (n.includes("black"))  return "#1C1C1C";
  if (n.includes("charcoal")) return "#404040";
  if (n.includes("grey") || n.includes("gray")) return "#9E9E9E";
  if (n.includes("navy"))   return "#1C2E4A";
  if (n.includes("cobalt") || n.includes("royal blue")) return "#2563EB";
  if (n.includes("slate blue") || n.includes("dusty blue")) return "#6A8CAF";
  if (n.includes("powder blue") || n.includes("sky")) return "#87CEEB";
  if (n.includes("blue"))   return "#60A5FA";
  if (n.includes("teal"))   return "#2DD4BF";
  if (n.includes("camel"))  return "#C19A6B";
  if (n.includes("caramel")) return "#C68642";
  if (n.includes("tan") || n.includes("sand")) return "#D2B48C";
  if (n.includes("nude"))   return "#E8C8B0";
  if (n.includes("beige"))  return "#E8DCC8";
  if (n.includes("latte") || n.includes("mocha")) return "#B5836A";
  if (n.includes("chocolate") || n.includes("espresso")) return "#5D3A1A";
  if (n.includes("brown"))  return "#795548";
  if (n.includes("dusty sage") || n.includes("sage green")) return "#9CAF88";
  if (n.includes("sage"))   return "#9CAF88";
  if (n.includes("olive"))  return "#7A8C5A";
  if (n.includes("forest") || n.includes("hunter")) return "#355E3B";
  if (n.includes("mint"))   return "#9BE7C4";
  if (n.includes("emerald")) return "#3D9970";
  if (n.includes("green"))  return "#6BAA75";
  if (n.includes("terracotta") || n.includes("clay")) return "#D4664A";
  if (n.includes("rust") || n.includes("burnt orange")) return "#A04030";
  if (n.includes("coral"))  return "#FF8A65";
  if (n.includes("orange")) return "#FF7043";
  if (n.includes("burgundy") || n.includes("wine") || n.includes("maroon")) return "#7C1E34";
  if (n.includes("red"))    return "#D32F2F";
  if (n.includes("dusty rose")) return "#D4A5A5";
  if (n.includes("blush"))  return "#F2C4BF";
  if (n.includes("rose"))   return "#E8A0A0";
  if (n.includes("mauve"))  return "#C8A0B0";
  if (n.includes("pink"))   return "#F06292";
  if (n.includes("lavender")) return "#C5B4E3";
  if (n.includes("lilac"))  return "#C8A2C8";
  if (n.includes("purple") || n.includes("violet")) return "#8B5CF6";
  if (n.includes("plum"))   return "#673AB7";
  if (n.includes("gold") || n.includes("amber")) return "#D4A017";
  if (n.includes("mustard") || n.includes("butter")) return "#E8C54A";
  if (n.includes("yellow")) return "#FDD835";
  return "#C8BFB0";
}

// ── Board card ────────────────────────────────────────────────────────────────

function BoardCard({ board, selected, onClick }: {
  board: Board; selected: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left border transition-all duration-200 group ${
        selected
          ? "border-foreground/60 bg-white/5"
          : "border-border hover:border-border-mid bg-white/[0.02] hover:bg-white/[0.04]"
      }`}
    >
      <div className="px-5 py-5 flex items-center justify-between">
        <p className="font-display font-light text-lg text-foreground leading-snug">
          {board.name}
        </p>
        <div className={`w-5 h-5 border flex items-center justify-center flex-shrink-0 transition-all duration-200 ${
          selected ? "border-foreground/60 bg-foreground/10" : "border-border group-hover:border-border-mid"
        }`}>
          {selected && (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1.5 5l2.5 2.5L8.5 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="text-foreground" />
            </svg>
          )}
        </div>
      </div>
    </button>
  );
}

// ── Pin grid ──────────────────────────────────────────────────────────────────

function PinGrid({ pins, loading }: { pins: PinData[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="mt-5 px-1 py-6 flex items-center gap-3">
        <div className="w-3.5 h-3.5 rounded-full border border-transparent border-t-foreground/60 animate-spin flex-shrink-0" style={{ animationDuration: "1s" }} />
        <p className="font-sans text-xs text-muted">Loading pins from your board…</p>
      </div>
    );
  }
  if (!pins.length) return null;
  return (
    <div className="mt-5 border-t border-border pt-5">
      <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-3">
        {pins.length} pins found — Claude will analyse these
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(60px,1fr))] gap-1">
        {pins.slice(0, 50).map((pin) => (
          <div key={pin.id} className="aspect-square overflow-hidden bg-white/5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={pin.thumbUrl} alt={pin.title} className="w-full h-full object-cover opacity-80" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Musing dots ───────────────────────────────────────────────────────────────

function MusingDots() {
  return (
    <span className="inline-flex ml-0.5">
      <span style={{ animation: "dotPulse 1.4s ease-in-out 0s infinite" }}>.</span>
      <span style={{ animation: "dotPulse 1.4s ease-in-out 0.28s infinite" }}>.</span>
      <span style={{ animation: "dotPulse 1.4s ease-in-out 0.56s infinite" }}>.</span>
    </span>
  );
}

// ── Loading screen ─────────────────────────────────────────────────────────────

function LoadingScreen({ title, steps, currentStep }: {
  title:       string;
  steps:       { label: string; sub: string }[];
  currentStep: number;
}) {
  return (
    <div className="fade-in flex flex-col items-center justify-center py-40 text-center">
      <div className="relative w-10 h-10 mb-16">
        <div className="absolute inset-0 rounded-full border border-border" />
        <div className="absolute inset-0 rounded-full border border-transparent border-t-foreground/60 animate-spin" style={{ animationDuration: "1.4s" }} />
      </div>
      <h2 className="font-display font-light text-4xl text-foreground mb-2">{title}</h2>
      <p className="font-sans text-base text-muted-strong mb-16">
        Musing<MusingDots />
      </p>
      <div className="flex flex-col gap-6 text-left max-w-xs w-full">
        {steps.map(({ label, sub }, i) => (
          <div key={i} className="flex items-start gap-4">
            <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 transition-all duration-700 ${
              i < currentStep ? "bg-accent" : i === currentStep ? "bg-foreground/80 shadow-[0_0_6px_rgba(240,232,216,0.4)]" : "bg-foreground/15"
            }`} />
            <div>
              <p className={`font-sans text-xs transition-colors duration-500 ${i <= currentStep ? "text-foreground" : "text-muted/50"}`}>{label}</p>
              <p className="font-sans text-[11px] text-muted/50 mt-0.5">{sub}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Shop card (browsable — no style notes) ────────────────────────────────────

function ShopCard({ product, userToken }: { product: AlgoliaProduct; userToken: string }) {
  const price = product.price != null
    ? formatPrice(product.price)
    : product.price_range !== "unknown" ? product.price_range : null;

  // Self-managed save state — initialised from localStorage on mount. We don't
  // lift this to the parent because save is a bookmark action, not a taste
  // signal (unlike Like). The brief flicker on first paint is acceptable.
  const [saved, setSaved] = useState(false);
  useEffect(() => { setSaved(isSaved(product.objectID)); }, [product.objectID]);

  const handleClick = () => {
    trackProductClick({ userToken, objectID: product.objectID, queryID: product._queryID ?? "", position: product._position ?? 1 });
    fetch("/api/taste/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userToken, product: { objectID: product.objectID, title: product.title, brand: product.brand, color: product.color, category: product.category, retailer: product.retailer, price_range: product.price_range, image_url: product.image_url } }),
    }).catch(() => {});
  };

  const handleSaveToggle = (e: React.MouseEvent) => {
    // The card is wrapped in an <a>, so we must stop the navigation.
    e.preventDefault();
    e.stopPropagation();
    if (saved) {
      removeSaved(product.objectID);
      setSaved(false);
    } else {
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
      setSaved(true);
    }
  };

  const brandLabel = (product.brand || product.retailer || "").trim();
  return (
    <a
      href={product.product_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className="group block"
    >
      {/* Image — the only element with the border + shadow. Brand moved out
          of the image to the text row below, matching /shop GridTile. */}
      <div className="aspect-[3/4] relative overflow-hidden bg-[rgba(42,51,22,0.04)] border border-border shadow-card group-hover:shadow-card-hover group-hover:border-border-mid transition-all duration-300">
        {product.image_url ? (
          <Image src={product.image_url} alt={displayTitle(product)} fill className="object-cover object-top group-hover:scale-[1.04] transition-transform duration-700" sizes="(max-width: 640px) 50vw, 33vw" unoptimized />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center font-display text-5xl font-light text-muted/20">▢</div>
        )}
        {/* Save bookmark — top-right of the image. Always visible when
            saved (filled olive); on rest it fades in on hover so the grid
            stays calm. Matches the rail bookmark in the scroll view. */}
        <button
          onClick={handleSaveToggle}
          aria-label={saved ? "Remove from shortlist" : "Save to shortlist"}
          className={`absolute top-2 right-2 z-10 w-9 h-9 rounded-full flex items-center justify-center bg-background/90 border border-border-mid text-foreground hover:border-foreground/60 transition-all duration-200 ${
            saved ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
          }`}
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4"
            fill={saved ? "currentColor" : "none"}
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
      </div>
      <div className="pt-3">
        {brandLabel && (
          <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1">{brandLabel}</p>
        )}
        <p className="font-sans text-xs text-foreground leading-snug line-clamp-2 mb-2">{displayTitle(product)}</p>
        <div className="flex items-center justify-between">
          {price ? <span className="font-sans text-xs font-medium text-foreground">{price}</span> : <span />}
          {/* Always-visible Shop affordance with subtle underline (matches /shop GridTile). */}
          <span className="font-sans text-[9px] tracking-widest uppercase text-foreground border-b border-foreground/40 pb-px group-hover:border-accent group-hover:text-accent transition-colors">Shop →</span>
        </div>
      </div>
    </a>
  );
}

// ── Shopping section by category ──────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  dress: "Dresses", top: "Tops", bottom: "Bottoms",
  jacket: "Jackets", shoes: "Shoes", bag: "Bags",
};

function ShoppingSection({ category, products, userToken }: {
  category: string; products: AlgoliaProduct[]; userToken: string;
}) {
  if (!products.length) return null;
  return (
    <div className="mb-12">
      <div className="flex items-baseline gap-4 mb-5 border-t border-border pt-6">
        <h3 className="font-display font-light text-2xl text-foreground">{CATEGORY_LABELS[category] ?? category}</h3>
        <span className="font-sans text-[9px] tracking-widest uppercase text-muted">{products.length} found</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5">
        {products.map((p) => <ShopCard key={p.objectID} product={p} userToken={userToken} />)}
      </div>
    </div>
  );
}

// ── Product scroll card ───────────────────────────────────────────────────────

function ProductScrollCard({
  product, index, activeIdx, userToken,
}: {
  product:    AlgoliaProduct;
  index:      number;
  activeIdx:  number;
  userToken:  string;
}) {
  const price  = product.price != null ? formatPrice(product.price) : null;
  const isNear = Math.abs(index - activeIdx) <= 2;

  const handleProductClick = () => {
    trackProductClick({ userToken, objectID: product.objectID, queryID: product._queryID ?? "", position: index + 1 });
    fetch("/api/taste/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userToken, product: { objectID: product.objectID, title: product.title, brand: product.brand, color: product.color, category: product.category, retailer: product.retailer, price_range: product.price_range, image_url: product.image_url } }),
    }).catch(() => {});
  };

  return (
    <a
      href={product.product_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleProductClick}
      className="relative flex flex-col bg-background block"
      style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}
      data-card-index={index}
    >
      {/* Full-bleed image */}
      <div className="absolute inset-0 bg-white/5">
        {product.image_url ? (
          <Image src={product.image_url} alt={displayTitle(product)} fill className="object-cover" unoptimized priority={isNear} sizes="100vw" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted/20 font-display text-6xl">▢</div>
        )}
      </div>

      {/* Retailer label */}
      <div className="absolute top-14 left-4 z-10 pointer-events-none">
        <span className="font-sans text-[8px] tracking-widest uppercase text-white/40">{product.retailer}</span>
      </div>

      {/* Bottom overlay */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-4 py-6 bg-gradient-to-t from-background via-background/70 to-transparent">
        {product.brand && <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1">{product.brand}</p>}
        <p className="font-display font-light text-xl text-foreground leading-snug mb-1">{displayTitle(product)}</p>
        {price && <p className="font-sans text-sm text-muted-strong mb-3">{price}</p>}
        <span className="inline-block font-sans text-[9px] tracking-widest uppercase text-foreground border-b border-foreground/30 pb-px">Shop →</span>
      </div>
    </a>
  );
}

// ── Product scroll view ───────────────────────────────────────────────────────

function ProductScrollView({
  products, onClose, userToken, onSayMore, onNearEnd, hasMore, loadingMore, likedIds, onLike,
}: {
  products:    AlgoliaProduct[];
  onClose:     () => void;
  userToken:   string;
  onSayMore?:  (comment: string) => void;
  // Infinite scroll — fires when the active card is within NEAR_END_THRESHOLD
  // of the end of the products array. Parent is responsible for debouncing
  // / single-flight guarding; onNearEnd may fire multiple times as the user
  // scrolls through the last few cards.
  onNearEnd?:  () => void;
  hasMore?:    boolean;
  loadingMore?: boolean;
  // Like state lifted to the parent so /api/shop-all pagination can bias
  // subsequent pages on session likes. When these are undefined the view
  // falls back to a local set (useful outside the shopping step).
  likedIds?:   Set<string>;
  onLike?:     (objectID: string) => void;
}) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const isScrolling   = useRef(false);

  // Near-end fire guard. React's state batching means onNearEnd might get
  // called twice for the same threshold crossing; the ref tracks the lowest
  // index we've already fired for so we don't double-fire the same page.
  const lastFiredNearEndRef = useRef(-1);
  const NEAR_END_THRESHOLD  = 3; // fire when active is within 3 of the end

  // Rail state — lifted out of the card so the rail can sit OFF to the
  // side of the card (matches the /shop french-aesthetic pattern) rather
  // than being overlaid on each scroll snap.
  const [localLikedIds, setLocalLikedIds] = useState<Set<string>>(new Set());
  const effectiveLikedIds = likedIds ?? localLikedIds;
  const [showSayMore, setShowSayMore] = useState(false);
  const [sayMoreText, setSayMoreText] = useState("");

  const activeProduct = products[activeIdx];
  const activeLiked   = activeProduct ? effectiveLikedIds.has(activeProduct.objectID) : false;

  // Save state — self-managed (save is a bookmark, not a taste signal) and
  // hydrated from localStorage whenever the active card changes.
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!activeProduct) return;
    if (isSaved(activeProduct.objectID)) {
      setSavedIds((prev) => (prev.has(activeProduct.objectID) ? prev : new Set(prev).add(activeProduct.objectID)));
    }
  }, [activeProduct]);
  const activeSaved = activeProduct ? savedIds.has(activeProduct.objectID) : false;

  const handleSave = useCallback(() => {
    const p = activeProduct;
    if (!p) return;
    if (savedIds.has(p.objectID)) {
      removeSaved(p.objectID);
      setSavedIds((prev) => {
        const next = new Set(prev);
        next.delete(p.objectID);
        return next;
      });
    } else {
      addSaved({
        objectID:    p.objectID,
        title:       p.title,
        brand:       p.brand,
        retailer:    p.retailer,
        price:       p.price,
        image_url:   p.image_url,
        product_url: p.product_url,
        category:    p.category,
        color:       p.color,
        price_range: p.price_range,
      });
      setSavedIds((prev) => new Set(prev).add(p.objectID));
    }
  }, [activeProduct, savedIds]);

  const handleLike = useCallback(() => {
    const p = activeProduct;
    if (!p) return;
    const already = effectiveLikedIds.has(p.objectID);
    if (onLike) {
      onLike(p.objectID);
    } else {
      setLocalLikedIds((prev) => {
        const next = new Set(prev);
        if (already) next.delete(p.objectID);
        else next.add(p.objectID);
        return next;
      });
    }
    if (!already) {
      trackProductClick({ userToken, objectID: p.objectID, queryID: p._queryID ?? "", position: activeIdx + 1 });
      fetch("/api/taste/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken, product: { objectID: p.objectID, title: p.title, brand: p.brand, color: p.color, category: p.category, retailer: p.retailer, price_range: p.price_range, image_url: p.image_url } }),
      }).catch(() => {});
    }
  }, [activeProduct, effectiveLikedIds, userToken, activeIdx, onLike]);

  // Fire onNearEnd when we cross into the last NEAR_END_THRESHOLD cards of
  // the current products list, and only once per threshold-crossing — the
  // ref re-arms when the products array grows (parent appended new items).
  useEffect(() => {
    if (!onNearEnd || !hasMore || loadingMore) return;
    if (products.length === 0) return;
    const threshold = Math.max(0, products.length - NEAR_END_THRESHOLD);
    if (activeIdx >= threshold && activeIdx > lastFiredNearEndRef.current) {
      lastFiredNearEndRef.current = activeIdx;
      onNearEnd();
    }
  }, [activeIdx, products.length, hasMore, loadingMore, onNearEnd]);

  // Re-arm the near-end guard when the products array grows (parent appended
  // a new page). Without this, if the user scrolled past the threshold,
  // triggered a fetch, and waited for results, the next threshold crossing
  // in the grown list wouldn't fire.
  useEffect(() => {
    lastFiredNearEndRef.current = -1;
  }, [products.length]);

  const handleSteerSubmit = useCallback((comment: string) => {
    const trimmed = comment.trim();
    if (!trimmed) return;
    onSayMore?.(trimmed);
    setSayMoreText("");
    setShowSayMore(false);
  }, [onSayMore]);

  // Close the Steer input when the user scrolls to a different card.
  useEffect(() => { setShowSayMore(false); setSayMoreText(""); }, [activeIdx]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, clientHeight } = containerRef.current;
    setActiveIdx(Math.round(scrollTop / clientHeight));
  }, []);

  // Force one-card-at-a-time scrolling (TikTok-style) by intercepting wheel events
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (isScrolling.current) return;
      isScrolling.current = true;
      el.scrollBy({ top: Math.sign(e.deltaY) * el.clientHeight, behavior: "smooth" });
      setTimeout(() => { isScrolling.current = false; }, 900);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keyboard navigation — arrow keys / J,K / space / Esc
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) return;
      const step = (direction: 1 | -1) => {
        if (isScrolling.current) return;
        isScrolling.current = true;
        el.scrollBy({ top: direction * el.clientHeight, behavior: "smooth" });
        setTimeout(() => { isScrolling.current = false; }, 900);
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

  useEffect(() => {
    products.slice(activeIdx + 1, activeIdx + 4).forEach((p) => {
      if (!p.image_url) return;
      const img = new window.Image();
      img.src = p.image_url;
    });
  }, [activeIdx, products]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      {/* Card + rail wrapper. Desktop: card and rail are flex siblings with
          gap-8, matching the /shop scroll view. Mobile: rail collapses to
          absolute overlay inside the card. */}
      <div className="relative z-10 flex items-center sm:gap-8" onClick={(e) => e.stopPropagation()}>
        {/* Card wrapper — positioning context for the Steer input + mobile rail */}
        <div className="relative">
          <div className="relative flex flex-col overflow-hidden rounded-sm shadow-2xl"
            style={{ width: "min(88vw, 400px)", height: "min(88vh, 720px)" }}
          >
            <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-background/90 to-transparent pointer-events-none">
              <button onClick={onClose} className="pointer-events-auto font-sans text-[9px] tracking-widest uppercase text-foreground/60 hover:text-foreground transition-colors">← Grid</button>
              <span className="font-sans text-[9px] tracking-widest uppercase text-foreground/30">{activeIdx + 1} / {products.length}</span>
            </div>
            <div ref={containerRef} onScroll={handleScroll} className="no-scrollbar w-full h-full overflow-y-scroll" style={{ scrollSnapType: "y mandatory" }}>
              {products.map((p, i) => (
                <ProductScrollCard key={p.objectID} product={p} index={i} activeIdx={activeIdx} userToken={userToken} />
              ))}
              {loadingMore && (
                <div className="flex items-center justify-center bg-background" style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}>
                  <p className="font-display italic text-xl text-muted">Finding more<span className="inline-flex ml-0.5">
                    <span style={{ animation: "dotPulse 1.4s ease-in-out 0s infinite" }}>.</span>
                    <span style={{ animation: "dotPulse 1.4s ease-in-out 0.28s infinite" }}>.</span>
                    <span style={{ animation: "dotPulse 1.4s ease-in-out 0.56s infinite" }}>.</span>
                  </span></p>
                </div>
              )}
              {!loadingMore && hasMore === false && products.length > 0 && (
                <div className="flex flex-col items-center justify-center bg-background gap-3" style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}>
                  <p className="font-display italic text-xl text-muted">That's everything that fits.</p>
                  <p className="font-sans text-[10px] tracking-widest uppercase text-muted/70">Refine via Steer, or go back to pick new inputs</p>
                </div>
              )}
            </div>
            {activeIdx === 0 && products.length > 1 && (
              <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1 pointer-events-none animate-bounce">
                <span className="font-sans text-[8px] tracking-widest uppercase text-white/20">scroll</span>
                <span className="text-white/20 text-xs">↓</span>
              </div>
            )}
          </div>

          {/* Steer input — centered over the card, narrower than the card
              so it reads as a whispered refinement. */}
          {showSayMore && onSayMore && (
            <form
              onSubmit={(e) => { e.preventDefault(); handleSteerSubmit(sayMoreText); }}
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
                <button type="submit" className="px-3 py-2 bg-foreground text-background font-sans text-[9px] tracking-widest uppercase whitespace-nowrap">→</button>
              </div>
            </form>
          )}

          {/* Mobile rail — overlaid on the card's bottom-right. */}
          <div className="sm:hidden absolute right-3 bottom-40 z-20 flex flex-col items-center gap-5">
            <RailButton label={activeLiked ? "Liked" : "Like"} onClick={handleLike}>
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill={activeLiked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
              </svg>
            </RailButton>
            {onSayMore && (
              <RailButton label={showSayMore ? "Cancel" : "Steer"} onClick={() => setShowSayMore((v) => !v)}>
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill={showSayMore ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </RailButton>
            )}
            <RailButton label={activeSaved ? "Saved" : "Save"} onClick={handleSave}>
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill={activeSaved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
              </svg>
            </RailButton>
          </div>
        </div>

        {/* Desktop rail — flex sibling of the card. */}
        <div className="hidden sm:flex flex-col items-center gap-6">
          <RailButton label={activeLiked ? "Liked" : "Like"} onClick={handleLike}>
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill={activeLiked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
          </RailButton>
          {onSayMore && (
            <RailButton label={showSayMore ? "Cancel" : "Steer"} onClick={() => setShowSayMore((v) => !v)}>
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill={showSayMore ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </RailButton>
          )}
          <RailButton label={activeSaved ? "Saved" : "Save"} onClick={handleSave}>
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill={activeSaved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
          </RailButton>
        </div>
      </div>
    </div>
  );
}

// ── Rail button: French-minimalist round button in the site's olive palette.
// Matches the /shop implementation so the two scroll views feel like one
// product. Cream fill, thin olive border, olive icon — active state is
// communicated by the ICON (heart fills, etc.), not by flipping the button.

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

// ── Onboarding quiz (first-visit fullscreen overlay) ─────────────────────────

const ONBOARDING_VIBES = [
  "Quiet Luxury", "Clean Girl", "Boho Free Spirit", "Dark Romance",
  "Coastal Cool", "Old Money", "Y2K Revival", "Romantic Feminine", "Streetwear Edge",
];

const ONBOARDING_OCCASIONS = [
  "Everyday looks", "Work & meetings", "Going out", "Vacation", "Special occasions",
];

const ONBOARDING_BUDGETS = ["Under $80", "$80–$250", "$250+", "Mix it up"];

function OnboardingQuiz({ onComplete }: { onComplete: () => void }) {
  const [screen, setScreen]           = useState(0);
  const [vibes, setVibes]             = useState<string[]>([]);
  const [occasions, setOccasions]     = useState<string[]>([]);
  const [budget, setBudget]           = useState<string>("");

  const toggleVibes = (v: string) =>
    setVibes((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]);

  const toggleOccasions = (o: string) =>
    setOccasions((prev) => prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o]);

  const handleComplete = () => {
    const data = { vibes, occasions, budget };
    localStorage.setItem("muse_onboarding_v1", JSON.stringify(data));
    onComplete();
  };

  const canNext0 = vibes.length >= 2;
  const canNext1 = occasions.length >= 1;
  const canNext2 = budget !== "";

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col items-center justify-center px-6 py-12 overflow-y-auto">
      <div className="w-full max-w-lg">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2.5 mb-12">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={`rounded-full transition-all duration-300 ${
                i === screen
                  ? "w-2 h-2 bg-foreground"
                  : i < screen
                  ? "w-1.5 h-1.5 bg-foreground/40"
                  : "w-1.5 h-1.5 bg-border"
              }`}
            />
          ))}
        </div>

        {/* Screen 0 — Vibes */}
        {screen === 0 && (
          <div className="fade-in">
            <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-3">Step 1 of 3</p>
            <h2 className="font-display font-light text-4xl text-foreground mb-2 leading-snug">
              What&apos;s your signature vibe?
            </h2>
            <p className="font-sans text-sm text-muted mb-8">Pick 2 or 3 that feel most like you</p>
            <div className="grid grid-cols-3 gap-2 mb-10">
              {ONBOARDING_VIBES.map((v) => (
                <button
                  key={v}
                  onClick={() => toggleVibes(v)}
                  className={`px-3 py-4 text-center border font-sans text-xs leading-snug transition-colors duration-150 ${
                    vibes.includes(v)
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted hover:border-border/60 hover:text-foreground"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
            <button
              onClick={() => setScreen(1)}
              disabled={!canNext0}
              className="w-full px-8 py-3.5 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200 disabled:opacity-25 disabled:cursor-not-allowed"
            >
              Next →
            </button>
            {vibes.length === 1 && (
              <p className="font-sans text-[11px] text-muted text-center mt-3">Pick at least 2</p>
            )}
          </div>
        )}

        {/* Screen 1 — Occasions */}
        {screen === 1 && (
          <div className="fade-in">
            <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-3">Step 2 of 3</p>
            <h2 className="font-display font-light text-4xl text-foreground mb-2 leading-snug">
              What are you shopping for?
            </h2>
            <p className="font-sans text-sm text-muted mb-8">Pick everything that applies</p>
            <div className="flex flex-col gap-2 mb-10">
              {ONBOARDING_OCCASIONS.map((o) => (
                <button
                  key={o}
                  onClick={() => toggleOccasions(o)}
                  className={`w-full px-5 py-4 text-left border font-sans text-sm transition-colors duration-150 ${
                    occasions.includes(o)
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted hover:border-border/60 hover:text-foreground"
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={() => setScreen(0)}
                className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={() => setScreen(2)}
                disabled={!canNext1}
                className="flex-1 px-8 py-3.5 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200 disabled:opacity-25 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            </div>
          </div>
        )}

        {/* Screen 2 — Budget */}
        {screen === 2 && (
          <div className="fade-in">
            <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-3">Step 3 of 3</p>
            <h2 className="font-display font-light text-4xl text-foreground mb-2 leading-snug">
              Your budget per piece?
            </h2>
            <p className="font-sans text-sm text-muted mb-8">We&apos;ll curate results accordingly</p>
            <div className="grid grid-cols-2 gap-2 mb-10">
              {ONBOARDING_BUDGETS.map((b) => (
                <button
                  key={b}
                  onClick={() => setBudget(b)}
                  className={`px-5 py-6 text-center border font-sans text-sm transition-colors duration-150 ${
                    budget === b
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted hover:border-border/60 hover:text-foreground"
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={() => setScreen(1)}
                className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={handleComplete}
                disabled={!canNext2}
                className="flex-1 px-8 py-3.5 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200 disabled:opacity-25 disabled:cursor-not-allowed"
              >
                Build my feed →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Questionnaire flow ────────────────────────────────────────────────────────

const QUIZ_OCCASIONS = ["Casual days", "Date night", "Work", "Weekend plans", "Vacation", "Party / events", "Wedding guest", "Gym / active"];
const QUIZ_VIBES     = ["Clean girl", "Quiet luxury", "Old money", "Coastal", "Bohemian", "Dark academia", "Streetwear", "Y2K", "Ballet core", "Cottage core", "Business casual", "Minimalist"];
const QUIZ_COLORS    = [
  { label: "Neutrals",     swatches: ["#FAF3E0", "#E8DCC8", "#C8BFB0", "#1C1C1C"] },
  { label: "Earth tones",  swatches: ["#D4664A", "#C19A6B", "#7A8C5A", "#5D3A1A"] },
  { label: "Pastels",      swatches: ["#C5B4E3", "#F2C4BF", "#9BE7C4", "#87CEEB"] },
  { label: "Bold & bright", swatches: ["#D32F2F", "#2563EB", "#FDD835", "#FF7043"] },
  { label: "Monochromatic", swatches: ["#F8F8F0", "#9E9E9E", "#404040", "#1C1C1C"] },
  { label: "Dark & moody", swatches: ["#7C1E34", "#355E3B", "#1C2E4A", "#673AB7"] },
];
const QUIZ_FITS      = ["Fitted & tailored", "Relaxed & flowy", "Oversized", "Structured", "Sporty", "Mix & match"];

function QuestionnaireFlow({ onComplete }: { onComplete: (answers: QuestionnaireAnswers) => void }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<QuestionnaireAnswers>({
    occasions: [], vibes: [], colors: [], fits: [], priceRange: "mid",
  });

  const toggle = (key: keyof Pick<QuestionnaireAnswers, "occasions" | "vibes" | "colors" | "fits">, value: string) => {
    setAnswers((prev) => {
      const arr = prev[key] as string[];
      return { ...prev, [key]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value] };
    });
  };

  const steps = [
    {
      title: "What are you shopping for?",
      sub:   "Pick all that apply",
      content: (
        <div className="grid grid-cols-2 gap-2">
          {QUIZ_OCCASIONS.map((o) => (
            <button key={o} onClick={() => toggle("occasions", o)}
              className={`px-3 py-3 text-left border font-sans text-xs transition-colors ${answers.occasions.includes(o) ? "border-foreground bg-foreground/10 text-foreground" : "border-border text-muted hover:border-border-mid"}`}>
              {o}
            </button>
          ))}
        </div>
      ),
    },
    {
      title: "What's your vibe?",
      sub:   "Pick your aesthetic(s)",
      content: (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {QUIZ_VIBES.map((v) => (
            <button key={v} onClick={() => toggle("vibes", v)}
              className={`px-3 py-3 text-left border font-sans text-xs transition-colors ${answers.vibes.includes(v) ? "border-foreground bg-foreground/10 text-foreground" : "border-border text-muted hover:border-border-mid"}`}>
              {v}
            </button>
          ))}
        </div>
      ),
    },
    {
      title: "Color direction?",
      sub:   "Pick what feels like you",
      content: (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {QUIZ_COLORS.map(({ label, swatches }) => (
            <button key={label} onClick={() => toggle("colors", label)}
              className={`p-3 text-left border transition-colors ${answers.colors.includes(label) ? "border-foreground bg-foreground/10" : "border-border hover:border-border-mid"}`}>
              <div className="flex gap-1 mb-2">
                {swatches.map((s) => <div key={s} className="w-4 h-4 rounded-full ring-1 ring-white/10" style={{ backgroundColor: s }} />)}
              </div>
              <p className="font-sans text-xs text-muted">{label}</p>
            </button>
          ))}
        </div>
      ),
    },
    {
      title: "How do you like to wear things?",
      sub:   "Fit preference",
      content: (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {QUIZ_FITS.map((f) => (
              <button key={f} onClick={() => toggle("fits", f)}
                className={`px-3 py-3 text-left border font-sans text-xs transition-colors ${answers.fits.includes(f) ? "border-foreground bg-foreground/10 text-foreground" : "border-border text-muted hover:border-border-mid"}`}>
                {f}
              </button>
            ))}
          </div>
          <div className="mt-6">
            <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-3">Budget</p>
            <div className="flex gap-2">
              {(["budget", "mid", "luxury"] as const).map((p) => (
                <button key={p} onClick={() => setAnswers((prev) => ({ ...prev, priceRange: p }))}
                  className={`flex-1 py-2 border font-sans text-xs capitalize transition-colors ${answers.priceRange === p ? "border-foreground bg-foreground/10 text-foreground" : "border-border text-muted hover:border-border-mid"}`}>
                  {p === "mid" ? "Mid-range" : p}
                </button>
              ))}
            </div>
          </div>
        </div>
      ),
    },
  ];

  const current = steps[step];
  const canNext = step < steps.length - 1;
  const canComplete = step === steps.length - 1;

  return (
    <div className="max-w-xl">
      {/* Progress */}
      <div className="flex gap-1 mb-8">
        {steps.map((_, i) => (
          <div key={i} className={`h-px flex-1 transition-colors duration-300 ${i <= step ? "bg-foreground/60" : "bg-border"}`} />
        ))}
      </div>

      <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-2">{step + 1} of {steps.length}</p>
      <h2 className="font-display font-light text-3xl text-foreground mb-1">{current.title}</h2>
      <p className="font-sans text-sm text-muted mb-6">{current.sub}</p>

      {current.content}

      <div className="flex items-center gap-4 mt-8">
        {step > 0 && (
          <button onClick={() => setStep((s) => s - 1)} className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors">← Back</button>
        )}
        {canNext && (
          <button onClick={() => setStep((s) => s + 1)} className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors">
            Next →
          </button>
        )}
        {canComplete && (
          <button onClick={() => onComplete(answers)} className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors">
            Find my look →
          </button>
        )}
      </div>
    </div>
  );
}

// ── Image upload zone ─────────────────────────────────────────────────────────

function ImageUploadZone({ images, onChange }: {
  images:   Array<{ url: string; file: File }>;
  onChange: (images: Array<{ url: string; file: File }>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const newFiles = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, 10 - images.length);
    const newImages = newFiles.map((f) => ({ url: URL.createObjectURL(f), file: f }));
    onChange([...images, ...newImages].slice(0, 10));
  };

  const remove = (idx: number) => {
    const next = images.filter((_, i) => i !== idx);
    onChange(next);
  };

  return (
    <div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
        className="border border-dashed border-border hover:border-border-mid transition-colors cursor-pointer px-6 py-10 text-center"
      >
        <p className="font-display font-light text-lg text-muted mb-1">Drop images here</p>
        <p className="font-sans text-xs text-muted/60">or click to upload — up to 10 images</p>
        <input ref={inputRef} type="file" multiple accept="image/*" className="hidden" onChange={(e) => handleFiles(e.target.files)} />
      </div>

      {images.length > 0 && (
        <div className="mt-4 grid grid-cols-5 gap-2">
          {images.map(({ url }, i) => (
            <div key={i} className="relative aspect-square overflow-hidden bg-white/5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="w-full h-full object-cover" />
              <button
                onClick={() => remove(i)}
                className="absolute top-1 right-1 w-5 h-5 bg-background/80 text-foreground/70 hover:text-foreground text-xs flex items-center justify-center"
              >
                ×
              </button>
            </div>
          ))}
          {images.length < 10 && (
            <button onClick={() => inputRef.current?.click()} className="aspect-square border border-dashed border-border flex items-center justify-center text-muted/40 hover:border-border-mid hover:text-muted transition-colors text-2xl">
              +
            </button>
          )}
        </div>
      )}

      {images.length > 0 && (
        <p className="font-sans text-[10px] text-muted mt-2">{images.length}/10 images selected</p>
      )}
    </div>
  );
}

// ── Loading step lists ────────────────────────────────────────────────────────

const SHOPPING_STEPS = [
  { label: "Reading your aesthetic",  sub: "Colors, textures, silhouettes & mood" },
  { label: "Finding your products",   sub: "Searching across 6 categories" },
];

const CATEGORIES = ["dress", "top", "bottom", "jacket", "shoes", "bag"] as const;

// focus_categories -> /api/shop-all categoryFilter label. Lets the shopping
// step paginate against the full category inventory (not just the 20-item
// bucket /api/shop returns) when Claude flagged the input as single-category.
const FOCUS_TO_CATEGORY_LABEL: Record<string, string> = {
  dress:  "Dresses",
  top:    "Tops",
  bottom: "Bottoms",
  jacket: "Outerwear",
  shoes:  "Shoes",
  bag:    "Bags and accessories",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { data: session } = useSession();

  // Core state
  const [step, setStep]                     = useState<Step>("boards");
  const [boards, setBoards]                 = useState<Board[]>([]);
  const [boardsLoading, setBoardsLoading]   = useState(true);
  const [selectedBoard, setSelectedBoard]   = useState<Board | null>(null);
  const [pins, setPins]                     = useState<PinData[]>([]);
  const [pinsLoading, setPinsLoading]       = useState(false);
  const [aesthetic, setAesthetic]           = useState<StyleDNA | null>(null);
  const [candidates, setCandidates]         = useState<CategoryCandidates | null>(null);
  const [shoppingStep, setShoppingStep]     = useState(0);
  const [errorMsg, setErrorMsg]             = useState("");
  const [userToken, setUserToken]           = useState("anon");
  const [shopViewMode, setShopViewMode]     = useState<ViewMode>("scroll");

  // Infinite-scroll pagination on top of the initial /api/shop candidates.
  // Once the user works through the visual-first picks Pinecone returned,
  // we page against /api/shop-all scoped to focus_categories[0] so they can
  // browse the entire relevant inventory (the whole shoes catalog for a
  // shoes board, etc). Resets on /api/shop re-fetch via handleShopMulti.
  const [extraProducts,    setExtraProducts]    = useState<AlgoliaProduct[]>([]);
  const [extraPage,        setExtraPage]        = useState(1);
  const [extraHasMore,     setExtraHasMore]     = useState(true);
  const [loadingMoreExtra, setLoadingMoreExtra] = useState(false);
  // Tracks products already in the feed (initial candidates + extras + Algolia
  // pages) so /api/shop-all pagination doesn't hand us duplicates.
  const seenExtraIdsRef = useRef<Set<string>>(new Set());

  // Session likes/dislikes in the shopping scroll view — used both to bias
  // subsequent /api/shop-all pages and to persist to taste memory.
  const [sessionLikedIds, setSessionLikedIds] = useState<Set<string>>(new Set());

  // Per-session click + dislike signals for live re-ranking of the LOADED
  // picks. Mirrors the pattern in /shop. Likes append to clickHistory; the
  // sortedProducts memo below feeds these into rankCards so the preloaded
  // batch adapts as the user reacts to it — without waiting for the user
  // to scroll past the preload and trigger /api/shop-all bias-shaped
  // pagination. Same refs power the steer flow: when handleSayMore mutates
  // `aesthetic`, the memo recomputes against the new aesthetic too.
  const clickHistoryRef    = useRef<ClickSignalLike[]>([]);
  const dislikedSignalsRef = useRef<ClickSignalLike[]>([]);
  // Tick bumped on every signal change — refs don't trigger React re-renders
  // on their own, so this counter forces useMemo to re-evaluate sortedProducts.
  const [signalsTick, setSignalsTick] = useState(0);

  // Multi-context blocks (up to 4, each independently typed)
  interface ContextBlock {
    id:            string;
    type:          InputMode;
    textQuery:     string;
    uploadedFiles: Array<{ url: string; file: File }>;
    answers?:      QuestionnaireAnswers;
  }
  const [contextBlocks, setContextBlocks]   = useState<ContextBlock[]>([
    // Pinterest is the primary funnel — boards carry the richest aesthetic
    // signal Claude can read, so that's the landing tab. The `?describe=…`
    // param below flips this to "text" when the user arrived from /shop's
    // Steer flow with a pre-filled prompt.
    { id: "b1", type: "pinterest", textQuery: "", uploadedFiles: [] },
  ]);
  // Price tier chosen in the intake form, before Build my feed. Sent to the
  // server so it's the FIRST constraint applied — candidate retrieval and
  // Claude's aesthetic analysis happen within this price universe, not on
  // top of it. "all" means no constraint.
  const [intakePriceTier, setIntakePriceTier] = useState<PriceTier>("all");
  const [isRefining, setIsRefining]         = useState(false);
  // Active steer — set by handleSayMore, forwarded on every /api/shop-all
  // page call so the full catalog walk stays scoped to aesthetic ∩ steer
  // as the user infinite-scrolls. Cleared on reset to boards.
  const [steerInterp, setSteerInterp]       = useState<SteerInterp | null>(null);

  // If the user arrived from /shop via the Steer button, their comment
  // comes in as ?describe=… — pre-fill the first text block. Reading via
  // window.location avoids useSearchParams, which forces dynamic rendering
  // and breaks the build without a Suspense boundary.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const describe = new URLSearchParams(window.location.search).get("describe");
    if (!describe) return;
    setContextBlocks((prev) => {
      if (prev.length > 0 && !prev[0].textQuery) {
        const next = [...prev];
        next[0] = { ...next[0], type: "text", textQuery: describe };
        return next;
      }
      return prev;
    });
    // Clean the URL so the param doesn't stick on reload
    const url = new URL(window.location.href);
    url.searchParams.delete("describe");
    window.history.replaceState({}, "", url.toString());
  }, []);


  useEffect(() => {
    if (session?.user?.id) setUserToken(session.user.id);
    else setUserToken(getUserToken());
  }, [session]);

  useEffect(() => {
    const token = (session as { accessToken?: string })?.accessToken;
    if (!token) { if (session !== undefined) setBoardsLoading(false); return; }
    setBoardsLoading(true);
    fetch("/api/pinterest/boards", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => { if (data.boards?.length) setBoards(data.boards); })
      .catch(() => {})
      .finally(() => setBoardsLoading(false));
  }, [session]);

  useEffect(() => {
    if (!selectedBoard) { setPins([]); return; }
    const token = (session as { accessToken?: string })?.accessToken;
    if (!token) return;
    setPins([]); setPinsLoading(true);
    fetch(`/api/pinterest/pins?boardId=${selectedBoard.id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => { if (data.pins?.length) setPins(data.pins); })
      .catch(() => {})
      .finally(() => setPinsLoading(false));
  }, [selectedBoard, session]);

  useEffect(() => {
    if (step === "shopping" && candidates) {
      const allProducts = CATEGORIES.flatMap((c) => candidates[c]);
      trackProductsViewed({ userToken, objectIDs: allProducts.map((p) => p.objectID) });
    }
  }, [step, candidates, userToken]);

  // ── Block management ──────────────────────────────────────────────────────

  const addBlock = useCallback(() => {
    setContextBlocks((prev) => prev.length >= 4 ? prev : [
      ...prev,
      { id: Math.random().toString(36).slice(2), type: "text" as InputMode, textQuery: "", uploadedFiles: [] },
    ]);
  }, []);

  const removeBlock = useCallback((id: string) => {
    setContextBlocks((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const updateBlock = useCallback((id: string, patch: Partial<{ type: InputMode; textQuery: string; uploadedFiles: Array<{ url: string; file: File }>; answers: QuestionnaireAnswers }>) => {
    setContextBlocks((prev) => prev.map((b) => b.id === id ? { ...b, ...patch } : b));
  }, []);

  // ── Unified shop handler (all blocks → single API call) ───────────────────

  const handleShopMulti = useCallback(async () => {
    setStep("shopping_loading");
    setErrorMsg("");
    setShoppingStep(0);
    // Safety net: if the stream's "aesthetic" event hasn't landed in 20 s
    // (catastrophically slow cold start), advance the dot anyway so the user
    // sees movement. Normal path clears this as soon as the event arrives.
    const t1 = setTimeout(() => setShoppingStep((s) => (s < 1 ? 1 : s)), 20000);
    try {
      const fileToVision = (file: File): Promise<VisionImage> =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            resolve({ base64: dataUrl.split(",")[1], mimeType: file.type });
          };
          reader.readAsDataURL(file);
        });

      const contexts = (await Promise.all(
        contextBlocks.map(async (b) => {
          if (b.type === "pinterest") {
            if (!selectedBoard) return null;
            return {
              mode:         "pinterest" as const,
              boardId:      selectedBoard.id,
              boardName:    selectedBoard.name,
              pins:         pins.map((p) => ({
                title:       p.title,
                description: p.description,
                altText:     p.altText,
                link:        p.link,
                domain:      p.domain,
                dominantColors: p.dominantColors,
              })),
              pinImageUrls: pins.slice(0, 20).map((p) => p.imageUrl),
            };
          }
          if (b.type === "text") {
            if (!b.textQuery.trim()) return null;
            return { mode: "text" as const, textQuery: b.textQuery.trim() };
          }
          if (b.type === "images") {
            if (!b.uploadedFiles.length) return null;
            const uploadedImages = await Promise.all(b.uploadedFiles.map(({ file }) => fileToVision(file)));
            return { mode: "images" as const, uploadedImages };
          }
          if (b.type === "quiz") {
            if (!b.answers) return null;
            return { mode: "quiz" as const, answers: b.answers };
          }
          return null;
        })
      )).filter((c): c is NonNullable<typeof c> => c !== null);

      // Inject onboarding answers as extra text context if available
      const onboardingRaw = localStorage.getItem("muse_onboarding_v1");
      if (onboardingRaw) {
        try {
          const { vibes, occasions, budget } = JSON.parse(onboardingRaw) as { vibes: string[]; occasions: string[]; budget: string };
          if (vibes?.length || occasions?.length || budget) {
            contexts.push({
              mode: "text" as const,
              textQuery: `User's stated preferences: vibes=[${vibes?.join(", ")}], occasions=[${occasions?.join(", ")}], budget=[${budget}]`,
            });
          }
        } catch {}
      }

      // Inject shortlist history as a *marginal* preference hint. Only fires
      // if the user has previously saved things — on a fresh account this is
      // a no-op. The getShortlistSummary helper frames it as a gentle signal
      // ("previously saved…") rather than a filter, so Claude weighs it
      // below the current input (pinterest / text / images) rather than
      // overriding it.
      const shortlistHint = getShortlistSummary();
      if (shortlistHint) {
        contexts.push({ mode: "text" as const, textQuery: shortlistHint });
      }

      if (contexts.length === 0) { setStep("boards"); return; }

      const res = await fetch("/api/shop", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ contexts, userToken, priceTier: intakePriceTier }),
      });
      if (!res.ok || !res.body) {
        // Non-2xx responses are returned as normal JSON (e.g. 400 on empty
        // contexts), not NDJSON — parse them accordingly for the error
        // message.
        let detail = "Shop failed";
        try {
          const maybe = await res.json();
          detail = maybe?.detail ?? maybe?.error ?? detail;
        } catch { /* ignore */ }
        throw new Error(detail);
      }

      // Stream parser. Server emits NDJSON: one JSON object per line,
      // separated by "\n". We buffer partial chunks (the TCP packet may
      // split a line) and dispatch each complete line as a progress event.
      //   phase=aesthetic  → dot advances, StyleDNA populated
      //   phase=candidates → candidates populated, clickHistory seeded
      //   phase=done       → transition to the shopping step
      //   phase=error      → surface the detail as an error
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = "";
      let sawDone   = false;
      type StreamEvent =
        | { phase: "aesthetic";  aesthetic: StyleDNA; cached?: boolean }
        | { phase: "candidates"; candidates: CategoryCandidates; clickSignals?: Array<{ object_id?: string; objectID?: string; category: string; brand: string; color: string; price_range: string; retailer?: string }> }
        | { phase: "done" }
        | { phase: "error"; detail: string };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // last element is the partial tail
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: StreamEvent;
          try { event = JSON.parse(trimmed) as StreamEvent; }
          catch { continue; } // skip malformed lines rather than abort
          if (event.phase === "aesthetic") {
            setAesthetic(event.aesthetic);
            setShoppingStep((s) => (s < 1 ? 1 : s));
          } else if (event.phase === "candidates") {
            setCandidates(event.candidates);
            // Seed seen-id set with the initial picks so /api/shop-all
            // pagination doesn't rehand us the same products.
            const seen = seenExtraIdsRef.current;
            seen.clear();
            for (const cat of CATEGORIES) {
              for (const p of event.candidates[cat] ?? []) seen.add(p.objectID);
            }
            setExtraProducts([]);
            setExtraPage(1);
            setExtraHasMore(true);
            setSessionLikedIds(new Set());
          } else if (event.phase === "done") {
            sawDone = true;
          } else if (event.phase === "error") {
            throw new Error(event.detail);
          }
        }
      }
      if (!sawDone) throw new Error("Stream ended unexpectedly");
      setStep("shopping");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong.");
      setStep("error");
    } finally { clearTimeout(t1); }
  }, [contextBlocks, selectedBoard, pins, userToken, intakePriceTier]);

  // ── Shop handlers ─────────────────────────────────────────────────────────


  // ── Session feedback: "say more" ──────────────────────────────────────────

  // New flow — reset the feed and pull a fresh pool from the full catalog
  // that satisfies aesthetic ∩ steer. Infinite scroll then continues under
  // the same steer, so the user is always browsing the full catalog slice
  // that matches both their board/query AND their steer — never just the
  // preloaded candidates.
  //
  // Fast path: fastParseSteerText handles "in black", "cheaper", "no florals"
  // etc. in 0 ms. That becomes the steerInterp we send to /api/shop-all.
  // For abstract phrases ("edgier", "more minimalist") we still call Claude
  // in the background and re-kick the fetch once its richer parse lands.
  //
  // /api/refine (aesthetic-refinement) stays in place for long-lived style
  // drift ("I want to lean more 90s"), but fires non-blocking so it doesn't
  // gate the visible feed.
  const handleSayMore = useCallback(async (comment: string) => {
    const trimmed = comment.trim();
    if (!trimmed) return;
    if (!aesthetic) return;

    // 0. Fast-parse the steer — this is what we'll ship to /api/shop-all.
    const fast = fastParseSteerText(trimmed);
    const initialInterp: SteerInterp | null = fast.isConcrete
      ? {
          search_terms: fast.search_terms,
          avoid_terms:  fast.avoid_terms,
          price_range:  fast.price_range,
          categories:   fast.categories,
          colors:       fast.colors,
          style_axes:   fast.style_axes,
          intent:       fast.intent,
        }
      : null;
    setSteerInterp(initialInterp);

    // 1. Blow away the current feed so the scroll view drops into its
    //    "Finding more…" state while the fresh pool loads.
    setCandidates((prev) => {
      if (!prev) return prev;
      const empty: CategoryCandidates = { dress: [], top: [], bottom: [], jacket: [], shoes: [], bag: [] };
      return empty;
    });
    setExtraProducts([]);
    setExtraPage(1);
    setExtraHasMore(true);
    seenExtraIdsRef.current.clear();

    // 2. If fast-parse was concrete, fire an immediate /api/shop-all fetch
    //    for page 1 with aesthetic + steer combined. Loaded into extras so
    //    the scroll view fills from the full catalog.
    if (initialInterp) {
      void refetchWithSteer(initialInterp);
    }

    // 3. Kick off Claude in parallel to upgrade the steer with style_axes /
    //    nuance on abstract inputs. When it returns, swap the steerInterp
    //    and re-fetch page 1 if it added meaningful signal.
    if (!fast.isConcrete || fast.isAbstract) {
      try {
        const res = await fetch("/api/steer-interpret", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ text: trimmed }),
        });
        if (res.ok) {
          const rich = (await res.json()) as SteerInterp;
          const hasRich = (rich.categories?.length ?? 0) > 0
            || (rich.colors?.length ?? 0) > 0
            || (rich.avoid_terms?.length ?? 0) > 0
            || (rich.search_terms?.length ?? 0) > 0
            || rich.price_range != null
            || Object.keys(rich.style_axes ?? {}).length > 0;
          if (hasRich) {
            setSteerInterp(rich);
            setExtraProducts([]);
            setExtraPage(1);
            setExtraHasMore(true);
            seenExtraIdsRef.current.clear();
            void refetchWithSteer(rich);
          }
        }
      } catch (err) {
        console.warn("[handleSayMore] steer-interpret failed:", err);
      }
    }

    // 4. Non-blocking aesthetic refine — updates the StyleDNA so subsequent
    //    pagination bakes the steer into Claude's retrieval phrases too.
    if (!isRefining) {
      setIsRefining(true);
      try {
        const res = await fetch("/api/refine", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            comment: trimmed,
            upcomingProductIds: [],
            currentAesthetic:   aesthetic,
            userToken,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.aesthetic) setAesthetic(data.aesthetic);
        }
      } catch (err) {
        console.warn("[handleSayMore] refine failed:", err);
      } finally {
        setIsRefining(false);
      }
    }
  }, [aesthetic, userToken, isRefining]);

  // ── Infinite scroll: page against /api/shop-all after initial candidates ──
  //
  // The initial /api/shop call returns ~15-20 visual-first picks (Pinecone +
  // CLIP + hybrid search). Once the user scrolls through those, paginate
  // against /api/shop-all scoped to focus_categories[0] so they can browse
  // the full inventory of their actual interest (all shoes for a shoes
  // board, all dresses for a dresses board, etc.). Session likes flow back
  // as bias so each page reflects what they've been engaging with.
  // Shared /api/shop-all fetch. Both infinite-scroll pagination and the
  // "refetch after steer" path use it. The caller decides the page + which
  // steer to forward (current state for pagination; explicit for refetch).
  const fetchShopAllPage = useCallback(async (
    page:   number,
    interp: SteerInterp | null,
  ): Promise<{ products: AlgoliaProduct[]; hasMore: boolean } | null> => {
    if (!aesthetic) return null;

    const focusCat = aesthetic.focus_categories?.[0];
    const categoryFilter = focusCat ? FOCUS_TO_CATEGORY_LABEL[focusCat] ?? "" : "";

    // Compose the Algolia free-text query. Order matters — user steer terms
    // go FIRST so Algolia's ranker reads them as the most salient intent.
    const interpTerms = interp
      ? [
          ...(interp.search_terms ?? []),
          ...(interp.colors       ?? []),
          ...(interp.categories   ?? []),
        ]
      : [];
    const steerQuery = [
      ...interpTerms,
      ...(aesthetic.style_keywords ?? []).slice(0, 6),
      ...(aesthetic.color_palette  ?? []).slice(0, 3).map((c) => c.split(" ").pop() ?? c),
    ].filter((t) => t && t.length > 2).join(" ");

    const likedProducts = [
      ...CATEGORIES.flatMap((c) => (candidates?.[c] ?? [])),
      ...extraProducts,
    ].filter((p) => sessionLikedIds.has(p.objectID));
    const byKey = (key: "brand" | "category" | "color", max: number): string[] => {
      const counts = new Map<string, number>();
      for (const p of likedProducts) {
        const v = String((p as unknown as Record<string, unknown>)[key] ?? "").trim();
        if (!v) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, max).map(([v]) => v);
    };
    const bias = {
      likedBrands:     byKey("brand",    5),
      likedCategories: byKey("category", 4),
      likedColors:     byKey("color",    3),
    };

    try {
      const res = await fetch("/api/shop-all", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          page,
          bias,
          likedProductIds: Array.from(sessionLikedIds),
          categoryFilter,
          steerQuery,
          // Structured steer — server applies price_range / avoid_terms as
          // post-filters and uses style_axes to re-rank inside Pinecone.
          steerInterp: interp ?? undefined,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return {
        products: (data.products ?? []) as AlgoliaProduct[],
        hasMore:  Boolean(data.hasMore),
      };
    } catch (err) {
      console.warn("[fetchShopAllPage] failed:", err);
      return null;
    }
  }, [aesthetic, candidates, extraProducts, sessionLikedIds]);

  const loadMoreExtras = useCallback(async () => {
    if (loadingMoreExtra || !extraHasMore || !aesthetic) return;
    setLoadingMoreExtra(true);
    try {
      const result = await fetchShopAllPage(extraPage, steerInterp);
      if (!result) { setExtraHasMore(false); return; }

      const seen = seenExtraIdsRef.current;
      const batch: AlgoliaProduct[] = [];
      for (const p of result.products) {
        if (seen.has(p.objectID)) continue;
        seen.add(p.objectID);
        batch.push(p);
      }

      setExtraProducts((prev) => [...prev, ...batch]);
      setExtraPage((p) => p + 1);
      if (!result.hasMore || batch.length === 0) setExtraHasMore(false);
    } finally {
      setLoadingMoreExtra(false);
    }
  }, [aesthetic, extraPage, extraHasMore, loadingMoreExtra, steerInterp, fetchShopAllPage]);

  // Triggered by handleSayMore — blow away the feed and refill page 1 with
  // the new steer applied against the full catalog.
  const refetchWithSteer = useCallback(async (interp: SteerInterp | null) => {
    if (!aesthetic) return;
    setLoadingMoreExtra(true);
    try {
      const result = await fetchShopAllPage(1, interp);
      if (!result) return;
      const seen = seenExtraIdsRef.current;
      seen.clear();
      for (const p of result.products) seen.add(p.objectID);
      setExtraProducts(result.products);
      setExtraPage(2);
      setExtraHasMore(result.hasMore);
    } finally {
      setLoadingMoreExtra(false);
    }
  }, [aesthetic, fetchShopAllPage]);

  // ── Reset ─────────────────────────────────────────────────────────────────

  const reset = () => {
    setStep("boards");
    setSelectedBoard(null);
    setPins([]);
    setAesthetic(null);
    setCandidates(null);
    setErrorMsg("");
    setShoppingStep(0);
    setShopViewMode("scroll");
    setContextBlocks([{ id: "b1", type: "pinterest", textQuery: "", uploadedFiles: [] }]);
    setIsRefining(false);
    setExtraProducts([]);
    setExtraPage(1);
    setExtraHasMore(true);
    setSessionLikedIds(new Set());
    setSteerInterp(null);
    seenExtraIdsRef.current.clear();
  };

  // ── Context block type labels ─────────────────────────────────────────────

  const BLOCK_TYPES: { mode: InputMode; label: string }[] = [
    { mode: "pinterest", label: "Pinterest" },
    { mode: "text",      label: "Describe"  },
    { mode: "images",    label: "Upload"    },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="px-8 py-5 border-b border-border sticky top-0 bg-background/90 backdrop-blur-md z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="font-display font-light tracking-[0.20em] text-base text-foreground hover:text-accent transition-colors duration-200">MUSE</Link>
          <div className="flex items-center gap-8">
            {isRefining && <span className="font-sans text-[10px] tracking-widest uppercase text-muted">Curating<MusingDots /></span>}
            {step === "shopping" && (
              <button onClick={reset} className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors">← New search</button>
            )}
            <button onClick={() => signOut({ callbackUrl: "/login" })} className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-8 py-16">

        {/* ── Search hub (boards step) ── */}
        {step === "boards" && (
          <div className="fade-in-up">
            <div className="mb-10">
              <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-[1.05] mb-4">
                What are we<br />shopping for?
              </h1>
              <p className="font-sans text-base text-muted-strong max-w-sm leading-relaxed">
                Describe the vibe, share a Pinterest board, or upload a few shots. We'll pull from hundreds of sustainable, vintage, preloved, and small-batch labels that fit.
              </p>
            </div>

            {/* Context blocks */}
            <div className="flex flex-col gap-4 mb-6 max-w-2xl">
              {contextBlocks.map((block) => (
                <div key={block.id} className="border border-border">
                  {/* Block type selector row */}
                  <div className="flex items-center justify-between border-b border-border">
                    <div className="flex">
                      {BLOCK_TYPES.map(({ mode, label }) => (
                        <button key={mode} onClick={() => updateBlock(block.id, { type: mode })}
                          className={`px-4 py-2.5 font-sans text-[9px] tracking-widest uppercase border-r border-border transition-colors duration-150 ${
                            block.type === mode ? "bg-foreground text-background" : "text-muted hover:text-foreground"
                          }`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {contextBlocks.length > 1 && (
                      <button onClick={() => removeBlock(block.id)}
                        className="px-4 py-2 font-sans text-[11px] text-muted hover:text-foreground transition-colors">
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Block form */}
                  <div className="p-5">
                    {/* Pinterest block */}
                    {block.type === "pinterest" && (() => {
                      const pinterestToken = (session as { accessToken?: string } | null)?.accessToken;
                      // Not connected — show inline connect button
                      if (!pinterestToken) {
                        return (
                          <div className="flex flex-col items-start gap-4">
                            <p className="font-sans text-xs text-muted leading-relaxed max-w-xs">
                              Connect your Pinterest to import your boards and pins.
                            </p>
                            <button
                              onClick={() => signIn("pinterest", { callbackUrl: "/dashboard" })}
                              className="flex items-center gap-2.5 px-5 py-2.5 bg-[#E60023] text-white font-sans text-[10px] tracking-widest uppercase hover:bg-[#c4001d] active:scale-[0.98] transition-all duration-150"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
                                <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
                              </svg>
                              Connect Pinterest
                            </button>
                          </div>
                        );
                      }
                      // Connected — show board picker or selected board
                      return (
                        <div>
                          {selectedBoard ? (
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="font-sans text-sm text-foreground">{selectedBoard.name}</p>
                                <p className="font-sans text-[11px] text-muted mt-0.5">{pinsLoading ? "Loading pins…" : `${pins.length} pins`}</p>
                              </div>
                              <button onClick={() => setSelectedBoard(null)}
                                className="font-sans text-[9px] tracking-widest uppercase text-muted hover:text-foreground transition-colors">
                                Change
                              </button>
                            </div>
                          ) : (
                            <div>
                              <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-3">Your boards</p>
                              <div className="flex flex-col gap-px border border-border max-h-64 overflow-y-auto">
                                {boardsLoading ? (
                                  <div className="px-5 py-6 text-center">
                                    <p className="font-sans text-xs text-muted">Loading your boards…</p>
                                  </div>
                                ) : boards.length === 0 ? (
                                  <div className="px-5 py-6 text-center">
                                    <p className="font-sans text-xs text-muted">No boards found.</p>
                                  </div>
                                ) : (
                                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                  (boards as any[]).map((board: Board) => (
                                    <BoardCard key={board.id} board={board} selected={false} onClick={() => setSelectedBoard(board)} />
                                  ))
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Text block */}
                    {block.type === "text" && (
                      <textarea
                        value={block.textQuery}
                        onChange={(e) => updateBlock(block.id, { textQuery: e.target.value })}
                        placeholder="e.g. rooftop birthday dinner in LA, want to look effortless but elevated, warm weather, not too formal…"
                        rows={3}
                        className="w-full bg-transparent font-sans text-sm text-foreground placeholder-muted/50 focus:outline-none resize-none leading-relaxed"
                      />
                    )}

                    {/* Upload block */}
                    {block.type === "images" && (
                      <ImageUploadZone
                        images={block.uploadedFiles}
                        onChange={(files) => updateBlock(block.id, { uploadedFiles: files })}
                      />
                    )}

                  </div>
                </div>
              ))}
            </div>

            {/* Add more context */}
            {contextBlocks.length < 4 && (
              <button onClick={addBlock}
                className="mb-8 font-sans text-[10px] tracking-widest uppercase text-muted-strong hover:text-foreground transition-colors border border-dashed border-border-mid px-5 py-2.5">
                + Add more context
              </button>
            )}

            {/* Price constraint — applied before Claude's aesthetic analysis
                so every downstream step (candidate fetch, curation) works
                within the user's chosen price range. Optional — default "All"
                lets Claude infer tier from the board. */}
            <div className="mb-8">
              <label className="block font-sans text-[10px] tracking-widest uppercase text-muted-strong mb-3">
                Price range
              </label>
              <PriceFilterBar tier={intakePriceTier} onChange={setIntakePriceTier} />
            </div>

            {/* Submit */}
            <div>
              <button
                onClick={handleShopMulti}
                disabled={!contextBlocks.some((b) =>
                  (b.type === "pinterest" && !!selectedBoard) ||
                  (b.type === "text" && !!b.textQuery.trim()) ||
                  (b.type === "images" && b.uploadedFiles.length > 0) ||
                  (b.type === "quiz" && !!b.answers)
                )}
                className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200 disabled:opacity-25 disabled:cursor-not-allowed">
                Build my feed →
              </button>
            </div>
          </div>
        )}

        {/* ── Shopping loading ── */}
        {step === "shopping_loading" && <LoadingScreen title="Finding your picks." steps={SHOPPING_STEPS} currentStep={shoppingStep} />}

        {/* ── Shopping results ── */}
        {step === "shopping" && aesthetic && candidates && (() => {
          const terms = [
            ...(aesthetic.style_keywords ?? []),
            ...(aesthetic.color_palette ?? []).map((c) => c.toLowerCase().split(" ").pop() ?? c),
            aesthetic.primary_aesthetic?.toLowerCase() ?? "",
          ].map((t) => t.toLowerCase());

          // Initial picks (visual-first matches from /api/shop) score-ranked
          // against aesthetic terms, then extra paginated products from
          // /api/shop-all appended in fetch order. Extras stay below initial
          // picks so Pinecone-best results surface first.
          const scored = CATEGORIES.flatMap((cat) => candidates[cat]).map((p) => {
            const haystack = [...(p.aesthetic_tags ?? []), (p.title ?? "").toLowerCase(), (p.description ?? "").toLowerCase()].join(" ");
            const score = terms.filter((t) => t.length > 2 && haystack.includes(t)).length;
            return { product: p, score };
          });
          scored.sort((a, b) => b.score - a.score);
          const sortedProducts = [
            ...scored.map(({ product }) => product),
            ...extraProducts,
          ];

          const handleLikeInScroll = (objectID: string) => {
            setSessionLikedIds((prev) => {
              const next = new Set(prev);
              if (next.has(objectID)) next.delete(objectID);
              else next.add(objectID);
              return next;
            });
          };

          return (
            <>
              {shopViewMode === "scroll" && (
                <ProductScrollView
                  products={sortedProducts}
                  onClose={() => setShopViewMode("grid")}
                  userToken={userToken}
                  onSayMore={handleSayMore}
                  onNearEnd={loadMoreExtras}
                  hasMore={extraHasMore}
                  loadingMore={loadingMoreExtra}
                  likedIds={sessionLikedIds}
                  onLike={handleLikeInScroll}
                />
              )}

              <div className="fade-in-up">
                <div className="flex items-start justify-between mb-8 gap-6">
                  <div>
                    <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-3">
                      {selectedBoard?.name ?? "Your search"}
                    </p>
                    <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight">
                      {sortedProducts.length} picks
                    </h1>
                  </div>
                  <div className="flex border border-border overflow-hidden flex-shrink-0 mt-1">
                    <button onClick={() => setShopViewMode("grid")}
                      className={`px-4 py-2 font-sans text-[9px] tracking-widest uppercase transition-colors duration-150 ${shopViewMode === "grid" ? "bg-foreground text-background" : "text-muted hover:text-foreground"}`}>
                      Grid
                    </button>
                    <button onClick={() => setShopViewMode("scroll")}
                      className={`px-4 py-2 font-sans text-[9px] tracking-widest uppercase transition-colors duration-150 border-l border-border ${shopViewMode === "scroll" ? "bg-foreground text-background" : "text-muted hover:text-foreground"}`}>
                      Scroll
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5 mb-14 mt-6">
                  {sortedProducts.map((product) => <ShopCard key={product.objectID} product={product} userToken={userToken} />)}
                </div>

                <div className="border-t border-border pt-7 mt-4">
                  <p className="font-sans text-[11px] text-muted/50 max-w-sm leading-relaxed">
                    MUSE earns a small affiliate commission if you purchase, at no extra cost to you.
                  </p>
                </div>
              </div>
            </>
          );
        })()}

        {/* ── Error ── */}
        {step === "error" && (
          <div className="fade-in flex flex-col items-center justify-center py-40 text-center">
            <h2 className="font-display font-light text-3xl text-foreground mb-3">Something went wrong.</h2>
            <p className="font-sans text-base text-muted-strong mb-12 max-w-sm">{errorMsg}</p>
            <button onClick={reset} className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors">Try again</button>
          </div>
        )}

      </main>
    </div>
  );
}
