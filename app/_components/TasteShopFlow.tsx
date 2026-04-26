"use client";

/**
 * TasteShopFlow — the full "tailor to your taste" intake → musing → scrolled
 * results experience, lifted from /dashboard so it can be embedded inline on
 * each /shop category page (Tops, Dresses, Bottoms, …) and on Shop all.
 *
 * Renders ONLY the body (intake / loading / results). Page-level chrome
 * (MUSE wordmark, sign-out, mobile menu, page background) is the consumer's
 * responsibility — see app/dashboard/page.tsx for the canonical chrome
 * wrapper and app/shop/page.tsx for the inline-on-category-page wrapper.
 *
 * Props:
 *   - categoryFilter:   when set (e.g. "Tops"), forces every retrieval step
 *                       (Claude focus_categories, /api/shop-all categoryFilter)
 *                       to that category so the user gets only items in the
 *                       category they were browsing.
 *   - callbackUrl:      where Pinterest OAuth bounces back after sign-in.
 *                       Defaults to /dashboard.
 *   - allowPinterest:   gate Pinterest tab behind sign-in. Anonymous users
 *                       on /shop see Describe + Upload only when false.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSession, signOut, signIn } from "next-auth/react";
import type { StyleDNA } from "@/lib/ai";
import { displayTitle, type AlgoliaProduct, type CategoryCandidates } from "@/lib/algolia";
import { getUserToken, trackProductClick, trackProductsViewed } from "@/lib/insights";
import type { QuestionnaireAnswers, VisionImage } from "@/lib/types";
import { addSaved, removeSaved, isSaved, getShortlistSummary } from "@/lib/saved";
import {
  loadSessionSignals,
  saveSessionSignals,
  flushSessionSignals,
} from "@/lib/session-signals";
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
      <div className="px-4 py-2.5 flex items-center justify-between">
        <p className="font-display font-light text-sm text-foreground leading-snug truncate pr-3">
          {board.name}
        </p>
        <div className={`w-4 h-4 border flex items-center justify-center flex-shrink-0 transition-all duration-200 ${
          selected ? "border-foreground/60 bg-foreground/10" : "border-border group-hover:border-border-mid"
        }`}>
          {selected && (
            <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
              <path d="M1.5 5l2.5 2.5L8.5 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="text-foreground" />
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

function ShopCard({
  product,
  userToken,
  liked   = false,
  onLike,
}: {
  product:    AlgoliaProduct;
  userToken:  string;
  /** Heart-button on/off state — driven by the parent's sessionLikedIds. */
  liked?:     boolean;
  /** When supplied, renders the Like (heart) button next to the bookmark.
   *  Click feeds the parent's rankCards signals so neighbouring picks shift
   *  toward visually-similar items — does NOT write to the shortlist. */
  onLike?:    (objectID: string) => void;
}) {
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

  // Like — taste signal only. Pushes into the parent's sessionLikedIds /
  // clickHistoryRef so rankCards re-ranks the loaded grid toward this item's
  // brand/category/color/visual neighbourhood. NEVER writes to the shortlist.
  const handleLikeToggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onLike) onLike(product.objectID);
  };

  // Save — pure bookmark. Writes to localStorage via lib/saved. Does NOT
  // affect rankCards or any retrieval bias. The two actions are deliberately
  // independent: Like is "show me more like this", Save is "I want to come
  // back to this exact piece".
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
        {/* Hover affordances — Like (heart) on the LEFT, Save (bookmark)
            on the RIGHT. Side-by-side in opposite corners so they never
            fight for the same click target on touch. Each button stays
            visible when "on" (filled), fades in on hover otherwise so the
            grid reads calmly at rest. */}
        {onLike && (
          <button
            onClick={handleLikeToggle}
            aria-label={liked ? "Remove like" : "Like — show me more like this"}
            className={`absolute top-2 left-2 z-10 w-9 h-9 rounded-full flex items-center justify-center bg-background/90 border border-border-mid text-foreground hover:border-foreground/60 transition-all duration-200 ${
              liked ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
            }`}
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4"
              fill={liked ? "currentColor" : "none"}
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
          </button>
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

  // One-card-at-a-time wheel scrolling, tuned for Mac trackpad inertia.
  //
  // The hard problem: a single trackpad swipe fires 30–60 wheel events over
  // ~600–900 ms (gesture + inertia tail). Naively triggering scrollBy on the
  // first event with a fixed-time release lock either fires once and feels
  // sluggish (long lock) or fires twice when the inertia tail accumulates
  // past the threshold again (short lock). The previous 900 ms lock had the
  // latter problem — fast trackpad swipes occasionally double-scrolled.
  //
  // Fix: release the lock only after a quiet period with NO wheel input.
  // While events keep streaming (gesture + inertia), we keep deferring
  // release. One continuous gesture → one snap, regardless of inertia length.
  //
  //   - Threshold 60 px for trackpad-shaped (small deltaY) input, 100 px for
  //     mouse wheels — same as /shop's handler.
  //   - QUIET_GAP 180 ms: release the lock that long after the LAST wheel
  //     event. Mouse-wheel clicks finish their stream within ~16 ms; trackpad
  //     inertia tails settle within ~120 ms. 180 ms catches both safely.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let deltaAccum = 0;
    let releaseTimer: number | null = null;
    const QUIET_GAP = 180;

    const release = () => {
      isScrolling.current = false;
      deltaAccum = 0;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();

      // Reschedule release on EVERY event so the lock holds for the full
      // gesture (events + inertia), then opens 180 ms after the last tick.
      if (releaseTimer != null) clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(release, QUIET_GAP);

      if (isScrolling.current) return;

      deltaAccum += e.deltaY;
      const isTrackpadShape = Math.abs(e.deltaY) < 40;
      const threshold = isTrackpadShape ? 60 : 100;
      if (Math.abs(deltaAccum) < threshold) return;

      isScrolling.current = true;
      el.scrollBy({ top: Math.sign(deltaAccum) * el.clientHeight, behavior: "smooth" });
      deltaAccum = 0;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (releaseTimer != null) clearTimeout(releaseTimer);
    };
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

export interface TasteShopFlowProps {
  /** Display label for category scope, e.g. "Tops" / "Dresses". Undefined = no scope (Shop all). */
  categoryFilter?:  string;
  /** Pinterest OAuth callback path. Defaults to /dashboard. */
  callbackUrl?:     string;
  /** When true (default), the Pinterest tab is shown. Set false to hide it
   *  when the page can't or shouldn't surface OAuth (e.g. anon users). */
  allowPinterest?:  boolean;
  /** Optional callback fired when the user clicks "← New search" inside the
   *  results view. When supplied, the in-flow reset is skipped and the
   *  caller takes over (e.g. clear the URL, return to default category feed). */
  onClearSearch?:   () => void;
  /** Fires `true` when the flow has produced personalized picks (or is in
   *  the middle of producing them) and `false` when the user resets back
   *  to the intake screen. Lets the parent hide its own default category
   *  feed + view-toggle bar so the picks aren't sandwiched between
   *  unrelated UI. */
  onSearchActiveChange?: (active: boolean) => void;
}

export function TasteShopFlow(props: TasteShopFlowProps = {}) {
  const {
    categoryFilter,
    callbackUrl    = "/dashboard",
    allowPinterest = true,
    onClearSearch,
    onSearchActiveChange,
  } = props;
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
  // Sort mode for the picks grid. "featured" preserves the rankCards order
  // (taste-relevance baked in by sortedProducts below); the two price modes
  // re-sort the loaded set client-side. Mirrors /shop's SortMode pattern.
  type ShopSortMode = "featured" | "price_asc" | "price_desc";
  const [shopSortMode, setShopSortMode]     = useState<ShopSortMode>("featured");

  // Tell the parent when the flow has produced personalized picks (or is in
  // the middle of producing them). Lets the parent hide its own default
  // category feed so the picks aren't sandwiched between unrelated UI.
  // step === "shopping" when results are showing; "shopping_loading" while
  // /api/shop is in flight; "boards" / "error" mean no active search.
  useEffect(() => {
    if (!onSearchActiveChange) return;
    const active = step === "shopping" || step === "shopping_loading";
    onSearchActiveChange(active);
  }, [step, onSearchActiveChange]);

  // Infinite-scroll pagination on top of the initial /api/shop candidates.
  // Once the user works through the visual-first picks Pinecone returned,
  // we page against /api/shop-all scoped to focus_categories[0] so they can
  // browse the entire relevant inventory (the whole shoes catalog for a
  // shoes board, etc). Resets on /api/shop re-fetch via handleShopMulti.
  const [extraProducts,    setExtraProducts]    = useState<AlgoliaProduct[]>([]);
  const [extraPage,        setExtraPage]        = useState(1);
  const [extraHasMore,     setExtraHasMore]     = useState(true);
  // Auto-broaden levels for true infinite scroll. When the current scope
  // (e.g. focus_category=shoes + steer "in black") exhausts, we bump this
  // and rerun page 1 with the most restrictive filter dropped, instead of
  // letting the feed dead-end. 0 = original; 1 = drop category; 2 = drop
  // steer; 3 = catalog walk under the aesthetic alone. Only at 3's
  // exhaustion do we genuinely set extraHasMore=false.
  const [extraLooseningLevel, setExtraLooseningLevel] = useState(0);
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
    // Default tab is Describe. Pinterest used to be the landing because
    // boards carry the richest aesthetic signal, but most first-time users
    // don't have a curated fashion board ready and the empty Pinterest
    // panel ("connect to import boards") was a dead end. A text prompt is
    // the universal entry point — anyone can type a vibe.
    { id: "b1", type: "text", textQuery: "", uploadedFiles: [] },
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
        body:    JSON.stringify({
          contexts,
          userToken,
          priceTier:      intakePriceTier,
          // When this flow is embedded on a /shop category page, pass the
          // category label through so /api/shop forces focus_categories on
          // the StyleDNA and we get back only items in that category.
          categoryFilter: categoryFilter ?? undefined,
        }),
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
            setExtraLooseningLevel(0);
            setSessionLikedIds(new Set());
            // Start each new feed with a clean session-signal slate so the
            // last run's reactions don't re-order this run's preloaded batch.
            clickHistoryRef.current    = [];
            dislikedSignalsRef.current = [];
            setSignalsTick(0);
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
    setExtraLooseningLevel(0);
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
            setExtraLooseningLevel(0);
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
  // steer to forward + which loosening level to apply (passed explicitly
  // so we don't capture a stale level via closure when called inside a
  // handler that just bumped or reset it).
  const fetchShopAllPage = useCallback(async (
    page:   number,
    interp: SteerInterp | null,
    level:  number = 0,
  ): Promise<{ products: AlgoliaProduct[]; hasMore: boolean } | null> => {
    if (!aesthetic) return null;

    // Category scope precedence:
    //   1. Component prop `categoryFilter` (e.g. "Tops" when embedded on the
    //      Tops category page) — wins so the user can't drift off-category
    //      via Claude's auto-detected focus.
    //   2. Otherwise: aesthetic.focus_categories[0] (the auto-detected scope
    //      from Pinterest pin counts / similar) — preserves the dashboard's
    //      historical behaviour of narrowing a shoes board to /shoes only.
    const focusCat        = aesthetic.focus_categories?.[0];
    const resolvedCategory = (categoryFilter ?? "").trim()
      || (focusCat ? FOCUS_TO_CATEGORY_LABEL[focusCat] ?? "" : "");

    // Effective scope based on the explicitly-passed `level` — drop the
    // most restrictive signal at each step so the feed never dead-ends.
    const useCategory = level < 1 ? resolvedCategory : "";
    const useInterp   = level < 2 ? interp           : null;

    // Compose the Algolia free-text query. Order matters — user steer terms
    // go FIRST so Algolia's ranker reads them as the most salient intent.
    const interpTerms = useInterp
      ? [
          ...(useInterp.search_terms ?? []),
          ...(useInterp.colors       ?? []),
          ...(useInterp.categories   ?? []),
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
          categoryFilter: useCategory,
          steerQuery,
          // Structured steer — server applies price_range / avoid_terms as
          // post-filters and uses style_axes to re-rank inside Pinecone.
          steerInterp: useInterp ?? undefined,
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
  }, [aesthetic, candidates, extraProducts, sessionLikedIds, categoryFilter]);

  const loadMoreExtras = useCallback(async () => {
    if (loadingMoreExtra || !extraHasMore || !aesthetic) return;
    setLoadingMoreExtra(true);
    try {
      const result = await fetchShopAllPage(extraPage, steerInterp, extraLooseningLevel);
      if (!result) {
        // Network/server error — try a broader scope before giving up.
        if (extraLooseningLevel < 3) {
          setExtraLooseningLevel((lvl) => lvl + 1);
          setExtraPage(1);
          return;
        }
        setExtraHasMore(false);
        return;
      }

      const seen = seenExtraIdsRef.current;
      const batch: AlgoliaProduct[] = [];
      for (const p of result.products) {
        if (seen.has(p.objectID)) continue;
        seen.add(p.objectID);
        batch.push(p);
      }

      setExtraProducts((prev) => [...prev, ...batch]);
      setExtraPage((p) => p + 1);

      // Auto-broaden when the current scope is exhausted (server says no
      // more OR every product was a duplicate). Keep extraHasMore=true so
      // the next loadMoreExtras call fires with the broader scope. Only
      // genuinely stop at level 3.
      if (!result.hasMore || batch.length === 0) {
        if (extraLooseningLevel < 3) {
          setExtraLooseningLevel((lvl) => lvl + 1);
          setExtraPage(1);
        } else {
          setExtraHasMore(false);
        }
      }
    } finally {
      setLoadingMoreExtra(false);
    }
  }, [aesthetic, extraPage, extraHasMore, loadingMoreExtra, steerInterp, fetchShopAllPage, extraLooseningLevel]);

  // Triggered by handleSayMore — blow away the feed and refill page 1 with
  // the new steer applied against the full catalog. Explicitly resets the
  // loosening level to 0 so the user sees the freshly-applied steer at the
  // most restrictive scope first.
  const refetchWithSteer = useCallback(async (interp: SteerInterp | null) => {
    if (!aesthetic) return;
    setExtraLooseningLevel(0);
    setLoadingMoreExtra(true);
    try {
      const result = await fetchShopAllPage(1, interp, 0);
      if (!result) return;
      // Re-seed the seen set from the ground up: initial candidates (still
      // rendered above the extras) + new fresh batch. Previously we cleared
      // seen and seeded only with the fresh batch, which dropped the initial
      // candidate IDs — next loadMoreExtras could then re-fetch them and
      // duplicate the render.
      const seen = seenExtraIdsRef.current;
      seen.clear();
      if (candidates) {
        for (const cat of CATEGORIES) {
          for (const p of candidates[cat] ?? []) seen.add(p.objectID);
        }
      }
      for (const p of result.products) seen.add(p.objectID);
      setExtraProducts(result.products);
      setExtraPage(2);
      setExtraHasMore(result.hasMore);
    } finally {
      setLoadingMoreExtra(false);
    }
  }, [aesthetic, candidates, fetchShopAllPage]);

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
    setContextBlocks([{ id: "b1", type: allowPinterest ? "pinterest" : "text", textQuery: "", uploadedFiles: [] }]);
    setIsRefining(false);
    setExtraProducts([]);
    setExtraPage(1);
    setExtraHasMore(true);
    setExtraLooseningLevel(0);
    setSessionLikedIds(new Set());
    clickHistoryRef.current    = [];
    dislikedSignalsRef.current = [];
    setSignalsTick(0);
    setSteerInterp(null);
    seenExtraIdsRef.current.clear();
  };

  // ── Context block type labels ─────────────────────────────────────────────
  // Pinterest is hidden when `allowPinterest` is false (anonymous /shop
  // visitors who haven't connected an account). Describe + Upload still work.

  const ALL_BLOCK_TYPES: { mode: InputMode; label: string }[] = [
    { mode: "pinterest", label: "Pinterest" },
    { mode: "text",      label: "Describe"  },
    { mode: "images",    label: "Upload"    },
  ];
  const BLOCK_TYPES = allowPinterest
    ? ALL_BLOCK_TYPES
    : ALL_BLOCK_TYPES.filter((b) => b.mode !== "pinterest");

  // Resolve "← New search" behaviour: when the consumer supplies onClearSearch
  // (e.g. /shop wants the URL to drop ?q= and re-show the default category
  // feed), defer to it. Otherwise fall back to the in-flow `reset` which
  // returns the user to the intake state inside this same component.
  const handleClearSearch = onClearSearch ?? reset;

  // Promote search-time taste signals (likedIds + clickHistory + dislikes)
  // into the shared `lib/session-signals` store BEFORE the search is torn
  // down — otherwise the local state inside this component is wiped by
  // `reset()` and the page underneath has no idea what the user just liked.
  // Existing persisted signals are merged (new entries prepended so they
  // weight as "most recent"); flushed synchronously so the parent's
  // re-hydrate-on-clear sees them on the very next tick.
  const persistThenClear = useCallback(() => {
    try {
      const existing = loadSessionSignals() ?? {
        likedIds: [], clickHistory: [], dislikedSignals: [], dwellTimes: {}, savedAt: 0,
      };
      // Likes — order doesn't matter much, but keep new IDs at the end.
      // Array.from(...) instead of `for…of` because the repo's tsconfig
      // has no `target` set and tsc rejects Set iterators without
      // --downlevelIteration. Same workaround as mixBrands in /shop.
      const likeSet = new Set(existing.likedIds);
      const mergedLikes = [...existing.likedIds];
      for (const id of Array.from(sessionLikedIds)) {
        if (!likeSet.has(id)) { likeSet.add(id); mergedLikes.push(id); }
      }
      // Click history — search-time clicks first so they're "most recent"
      // and dominate the recency-decayed ranking on the next fetch.
      const seenClicks = new Set(existing.clickHistory.map((s) => s.objectID));
      const mergedClicks = [
        ...clickHistoryRef.current.filter((s) => !seenClicks.has(s.objectID)),
        ...existing.clickHistory,
      ];
      const seenDis = new Set(existing.dislikedSignals.map((s) => s.objectID));
      const mergedDislikes = [
        ...dislikedSignalsRef.current.filter((s) => !seenDis.has(s.objectID)),
        ...existing.dislikedSignals,
      ];
      saveSessionSignals({
        likedIds:        mergedLikes,
        clickHistory:    mergedClicks,
        dislikedSignals: mergedDislikes,
        dwellTimes:      existing.dwellTimes,
      });
      flushSessionSignals();
    } catch {
      // Best-effort — if persistence fails, still let the user back out of
      // the search. Worst case is the underneath feed isn't re-personalised.
    }
    handleClearSearch();
  }, [sessionLikedIds, handleClearSearch]);

  return (
    <div className="taste-shop-flow">
      {/* Lightweight chrome — "← Go back" anchored to the LEFT, the
          "Curating…" indicator (when refining) on the right. The button
          unwinds the search back to the page that was up before submit:
          on /shop that drops ?q= and re-shows the default category feed
          (handled by onClearSearch), elsewhere it returns to the intake
          state inside this same component. */}
      {(isRefining || step === "shopping") && (
        <div className="flex items-center justify-between gap-6 px-8 pt-4 pb-2">
          {step === "shopping" ? (
            <button
              onClick={persistThenClear}
              className="font-sans text-xs tracking-widest uppercase text-muted hover:text-foreground transition-colors"
            >
              ← Go back
            </button>
          ) : <span />}
          {isRefining && (
            <span className="font-sans text-[10px] tracking-widest uppercase text-muted">
              Curating<MusingDots />
            </span>
          )}
        </div>
      )}

      {/* Width: the intake (boards step) stays in a comfortable max-w-5xl
          column so it reads as a search panel. Once the user submits and
          we render the loading/results, drop the column constraint and the
          horizontal padding so the picks fill the available width naturally
          (the parent on /shop also drops its border in this state — see
          app/shop/page.tsx). */}
      <div className={
        step === "boards"
          ? "max-w-5xl mx-auto px-8 py-5"
          : "py-5"
      }>

        {/* ── Search hub (boards step) ──
            Inline above the category grid. Sizing is the editorial-minimal
            middle ground: generous enough that the heading reads as a
            heading and the cards have breathing room, compact enough that
            the first row of products is still visible under the fold on a
            laptop. The earlier pass collapsed everything to form-field
            scale and the panel started reading as utility chrome instead
            of a deliberate prompt. */}
        {step === "boards" && (
          <div className="fade-in-up">
            <div className="mb-5">
              <h2 className="font-display font-light text-xl sm:text-2xl text-foreground leading-tight mb-1.5">
                What are we shopping for?
              </h2>
              <p className="font-sans text-sm text-muted-strong max-w-lg leading-relaxed">
                Describe the vibe, share a Pinterest board, or upload a few shots.
              </p>
            </div>

            {/* Context blocks */}
            <div className="flex flex-col gap-3 mb-5 max-w-xl">
              {contextBlocks.map((block, idx) => (
                <div key={block.id} className="border border-border">
                  {/* Block type selector row — tabs on the left, the
                      "+ Add more context" affordance trails on the right
                      of the LAST block's tab row so it reads as part of
                      the tab strip rather than a separate stacked button. */}
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
                    <div className="flex items-center">
                      {idx === contextBlocks.length - 1 && contextBlocks.length < 4 && (
                        <button onClick={addBlock}
                          className="px-4 py-2.5 font-sans text-[9px] tracking-widest uppercase text-muted-strong hover:text-foreground transition-colors border-l border-border">
                          + Add more context
                        </button>
                      )}
                      {contextBlocks.length > 1 && (
                        <button onClick={() => removeBlock(block.id)}
                          className="px-4 py-2 font-sans text-[11px] text-muted hover:text-foreground transition-colors border-l border-border">
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Block form */}
                  <div className="p-4">
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
                              onClick={() => signIn("pinterest", { callbackUrl })}
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
                              {/* Constrained height so only ~1 board peeks
                                  before the user scrolls. Was max-h-64
                                  (256 px ≈ 4 cards); now max-h-12 (48 px)
                                  with skinnier card padding so exactly one
                                  card sits in the viewport. */}
                              <div className="flex flex-col gap-px border border-border max-h-12 overflow-y-auto">
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
                        rows={2}
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

            {/* Price + Build stacked vertically, both left-aligned with
                the rest of the panel. The Add-more affordance now lives
                inline at the right edge of the tab row above. */}
            <div className="max-w-xl">
              <div className="mb-5">
                <label className="block font-sans text-[9px] tracking-widest uppercase text-muted-dim mb-1.5">
                  Price
                </label>
                <PriceFilterBar tier={intakePriceTier} onChange={setIntakePriceTier} />
              </div>

              <button
                onClick={handleShopMulti}
                disabled={!contextBlocks.some((b) =>
                  (b.type === "pinterest" && !!selectedBoard) ||
                  (b.type === "text" && !!b.textQuery.trim()) ||
                  (b.type === "images" && b.uploadedFiles.length > 0) ||
                  (b.type === "quiz" && !!b.answers)
                )}
                className="px-6 py-2.5 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200 disabled:opacity-25 disabled:cursor-not-allowed">
                Build my feed →
              </button>
            </div>
          </div>
        )}

        {/* ── Shopping loading ── */}
        {step === "shopping_loading" && <LoadingScreen title="Finding your picks." steps={SHOPPING_STEPS} currentStep={shoppingStep} />}

        {/* ── Shopping results ── */}
        {step === "shopping" && aesthetic && candidates && (() => {
          // Read signalsTick so React re-runs this IIFE when the signal refs
          // mutate (handleLikeInScroll bumps the tick after pushing to
          // clickHistory). Refs don't trigger re-renders on their own;
          // `aesthetic` / `candidates` / `extraProducts` already do.
          void signalsTick;

          // Aesthetic-term list — reference only, retained as a tiebreaker
          // hook for future. The primary ordering is rankCards below.
          const terms = [
            ...(aesthetic.style_keywords ?? []),
            ...(aesthetic.color_palette ?? []).map((c) => c.toLowerCase().split(" ").pop() ?? c),
            aesthetic.primary_aesthetic?.toLowerCase() ?? "",
          ].map((t) => t.toLowerCase());
          void terms;

          // Render-time dedup: the seenExtraIdsRef guard catches most cases at
          // fetch time, but if an upstream bug ever leaks the same objectID
          // into `candidates` and `extraProducts` (or into two category
          // buckets of `candidates`), we filter it out here as a last line
          // of defense. First occurrence wins so the original rank position
          // is preserved; later occurrences silently drop.
          const seenRender = new Set<string>();
          const allProducts: AlgoliaProduct[] = [];
          for (const p of [
            ...CATEGORIES.flatMap((cat) => candidates[cat]),
            ...extraProducts,
          ]) {
            if (seenRender.has(p.objectID)) continue;
            seenRender.add(p.objectID);
            allProducts.push(p);
          }

          // rankCards is the same scorer /shop uses in its scroll view — it
          // boosts items whose brand/category/color match the user's likes
          // and penalises those that match dislikes. Running it on the
          // loaded batch (initial + extras) means the preloaded picks
          // re-order live as the user reacts, instead of staying frozen
          // until they scroll past and /api/shop-all's bias-shaped pagination
          // kicks in. The steer flow (handleSayMore) mutates `aesthetic`,
          // which also bumps this recompute via the outer conditional.
          const signals: ScoringSignals = {
            likedProductIds: sessionLikedIds,
            clickHistory:    clickHistoryRef.current,
            dislikedSignals: dislikedSignalsRef.current,
            dwellTimes:      {},                            // no dwell tracking on dashboard yet
            aestheticPrice:  aesthetic.price_range ?? "mid",
          };
          const cards: ScoringCard[] = allProducts.map((p) => ({
            id:       p.objectID,
            products: [{
              objectID:    p.objectID,
              category:    p.category,
              brand:       p.brand,
              color:       p.color,
              price_range: p.price_range,
              retailer:    p.retailer,
            }],
            liked: sessionLikedIds.has(p.objectID),
          }));
          const ranked = rankCards(cards, signals) as ScoringCard[];
          const byId = new Map(allProducts.map((p) => [p.objectID, p]));
          const taste_sortedProducts = ranked
            .map((c) => byId.get(c.id))
            .filter((p): p is AlgoliaProduct => p != null);

          // Apply optional price sort on top of the taste-relevance order.
          // "featured" = leave taste order alone. Items without a price always
          // sink to the end so a missing price doesn't accidentally win
          // either ranking direction.
          let sortedProducts = taste_sortedProducts;
          if (shopSortMode !== "featured") {
            const priced   = taste_sortedProducts.filter((p) => p.price != null);
            const unpriced = taste_sortedProducts.filter((p) => p.price == null);
            priced.sort((a, b) =>
              shopSortMode === "price_asc"
                ? (a.price as number) - (b.price as number)
                : (b.price as number) - (a.price as number),
            );
            sortedProducts = [...priced, ...unpriced];
          }

          const productToSignal = (p: AlgoliaProduct): ClickSignalLike => ({
            objectID:    p.objectID,
            category:    p.category ?? "",
            brand:       p.brand ?? "",
            color:       p.color ?? "",
            price_range: p.price_range ?? "mid",
            retailer:    p.retailer,
          });

          const handleLikeInScroll = (objectID: string) => {
            const product = byId.get(objectID);
            setSessionLikedIds((prev) => {
              const next = new Set(prev);
              if (next.has(objectID)) {
                next.delete(objectID);
                // Unlike: leave clickHistory alone (the engagement still
                // happened). Toggling the heart back off shouldn't erase
                // the taste signal — /shop follows the same convention.
              } else {
                next.add(objectID);
                if (product) {
                  // Cap at 30 — matches /shop's bound and keeps rankCards'
                  // per-card work bounded as the session grows.
                  clickHistoryRef.current = [productToSignal(product), ...clickHistoryRef.current].slice(0, 30);
                }
              }
              return next;
            });
            // Bump tick so the IIFE re-runs with the updated clickHistory.
            setSignalsTick((t) => t + 1);
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
                <div className="flex items-end justify-between mb-8 gap-6 flex-wrap">
                  <div>
                    <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight">
                      {sortedProducts.length} picks
                    </h1>
                  </div>
                  {/* View toggle + sort toggle on a single row, right-aligned.
                      Used to stack vertically; merging them onto one line keeps
                      the toolbar compact and frees the heading area visually. */}
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {/* View toggle — Grid / Scroll, applies to the picks
                        below (and the ProductScrollView modal). */}
                    <div className="flex border border-border overflow-hidden">
                      <button onClick={() => setShopViewMode("grid")}
                        className={`px-4 py-2 font-sans text-[9px] tracking-widest uppercase transition-colors duration-150 ${shopViewMode === "grid" ? "bg-foreground text-background" : "text-muted hover:text-foreground"}`}>
                        Grid
                      </button>
                      <button onClick={() => setShopViewMode("scroll")}
                        className={`px-4 py-2 font-sans text-[9px] tracking-widest uppercase transition-colors duration-150 border-l border-border ${shopViewMode === "scroll" ? "bg-foreground text-background" : "text-muted hover:text-foreground"}`}>
                        Scroll
                      </button>
                    </div>
                    {/* Price sort — re-orders the LOADED picks client-side.
                        "Featured" preserves the rankCards taste-relevance
                        order. */}
                    <div className="flex border border-border overflow-hidden">
                      {([
                        { label: "Featured", value: "featured"   },
                        { label: "Price ↑",  value: "price_asc"  },
                        { label: "Price ↓",  value: "price_desc" },
                      ] as const).map((opt, i) => (
                        <button
                          key={opt.value}
                          onClick={() => setShopSortMode(opt.value)}
                          className={`px-3 py-2 font-sans text-[9px] tracking-widest uppercase transition-colors duration-150 ${i === 0 ? "" : "border-l border-border"} ${
                            shopSortMode === opt.value
                              ? "bg-foreground text-background"
                              : "text-muted hover:text-foreground"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5 mb-14 mt-6">
                  {sortedProducts.map((product) => (
                    <ShopCard
                      key={product.objectID}
                      product={product}
                      userToken={userToken}
                      // Like = taste signal (rerank). Save (the bookmark on
                      // the right of the same tile) is independent localStorage.
                      // Reuses the same handler the scroll-view heart calls.
                      liked={sessionLikedIds.has(product.objectID)}
                      onLike={handleLikeInScroll}
                    />
                  ))}
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

      </div>
    </div>
  );
}
