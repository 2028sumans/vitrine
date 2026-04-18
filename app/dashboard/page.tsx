"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSession, signOut, signIn } from "next-auth/react";
import type { StyleDNA, CuratedProduct } from "@/lib/ai";
import type { AlgoliaProduct, CategoryCandidates } from "@/lib/algolia";
import { getUserToken, trackProductClick, trackProductsViewed } from "@/lib/insights";
import type { QuestionnaireAnswers, VisionImage } from "@/lib/types";
import { rankCards, reRankUpcoming, interpretDwell, scoreCard, type ScoringSignals, type ClickSignalLike } from "@/lib/scoring";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a numeric price as "$1,481" with thousand separators. */
function formatPrice(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Board    = { id: string; name: string };
type Step     = "boards" | "shopping_loading" | "shopping" | "edit_loading" | "results" | "error";
type ViewMode = "grid" | "scroll";
type InputMode = "pinterest" | "text" | "images" | "quiz";

interface OutfitCard {
  id:       string;
  label:    string;
  role:     string;
  products: CuratedProduct[];
  liked:    boolean;
}

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

  const handleClick = () => {
    trackProductClick({ userToken, objectID: product.objectID, queryID: product._queryID ?? "", position: product._position ?? 1 });
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
      onClick={handleClick}
      className="group block border border-border hover:border-border-mid bg-background shadow-card hover:shadow-card-hover transition-all duration-300"
    >
      <div className="aspect-[3/4] relative overflow-hidden bg-[rgba(42,51,22,0.04)]">
        {product.image_url ? (
          <Image src={product.image_url} alt={product.title} fill className="object-cover object-top group-hover:scale-[1.04] transition-transform duration-700" sizes="(max-width: 640px) 50vw, 33vw" unoptimized />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center font-display text-5xl font-light text-muted/20">▢</div>
        )}
        <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-background/80 to-transparent">
          <p className="font-sans text-[9px] tracking-widest uppercase text-foreground/60">{product.retailer}</p>
        </div>
      </div>
      <div className="p-3 border-t border-border">
        {product.brand && product.brand.toLowerCase() !== product.retailer.toLowerCase() && (
          <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1">{product.brand}</p>
        )}
        <p className="font-sans text-xs text-foreground leading-snug line-clamp-2 mb-2">{product.title}</p>
        <div className="flex items-center justify-between">
          {price ? <span className="font-sans text-xs font-medium text-foreground">{price}</span> : <span />}
          <span className="font-sans text-[9px] tracking-widest uppercase text-muted group-hover:text-accent transition-colors">Shop →</span>
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

// ── Product card (edit results — has style notes) ─────────────────────────────

function ProductCard({ product, position, userToken }: {
  product: CuratedProduct; position: number; userToken: string;
}) {
  const price = product.price != null ? formatPrice(product.price) : product.price_range !== "unknown" ? product.price_range : null;

  const handleClick = () => {
    trackProductClick({ userToken, objectID: product.objectID, queryID: product._queryID ?? "", position });
    fetch("/api/taste/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userToken, product: { objectID: product.objectID, title: product.title, brand: product.brand, color: product.color, category: product.category, retailer: product.retailer, price_range: product.price_range, image_url: product.image_url } }),
    }).catch(() => {});
  };

  return (
    <a href={product.product_url || "#"} target="_blank" rel="noopener noreferrer" onClick={handleClick}
      className="group block border border-border hover:border-border-mid bg-background shadow-card hover:shadow-card-hover transition-all duration-300">
      <div className="aspect-[3/4] relative overflow-hidden bg-[rgba(42,51,22,0.04)]">
        {product.image_url ? (
          <Image src={product.image_url} alt={product.title} fill className="object-cover object-top group-hover:scale-[1.04] transition-transform duration-700" sizes="(max-width: 640px) 50vw, 33vw" unoptimized />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center font-display text-5xl font-light text-muted/20">▢</div>
        )}
        {product.outfit_role && product.outfit_role !== "versatile staple" && (
          <div className="absolute top-3 right-3">
            <span className="font-sans text-[8px] tracking-widest uppercase bg-background/80 backdrop-blur-sm text-foreground/70 px-2 py-1">{product.outfit_role}</span>
          </div>
        )}
        <div className="absolute bottom-0 left-0 right-0 px-3 py-2.5 bg-gradient-to-t from-background/60 to-transparent">
          <p className="font-sans text-[9px] tracking-widest uppercase text-foreground/60">{product.retailer}</p>
        </div>
      </div>
      <div className="p-4 border-t border-border">
        {product.brand && product.brand.toLowerCase() !== product.retailer.toLowerCase() && (
          <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1.5">{product.brand}</p>
        )}
        <p className="font-sans text-sm text-foreground leading-snug line-clamp-2 mb-2.5">{product.title}</p>
        {product.style_note && (
          <p className="font-display font-light italic text-base text-muted-strong leading-relaxed line-clamp-2 mb-2">&ldquo;{product.style_note}&rdquo;</p>
        )}
        {product.how_to_wear && (
          <p className="font-sans text-[11px] text-muted leading-relaxed mb-3">
            <span className="text-accent font-medium">Wear it: </span>{product.how_to_wear}
          </p>
        )}
        <div className="flex items-center justify-between pt-3 border-t border-border">
          {price ? <span className="font-sans text-xs font-medium text-foreground">{price}</span> : <span />}
          <span className="font-sans text-[9px] tracking-widest uppercase text-muted group-hover:text-accent transition-colors duration-200">Shop →</span>
        </div>
      </div>
    </a>
  );
}

// ── Outfit section ────────────────────────────────────────────────────────────

function OutfitSection({ label, role, products, startPosition, userToken }: {
  label: string; role?: string; products: CuratedProduct[]; startPosition: number; userToken: string;
}) {
  if (!products.length) return null;
  return (
    <div className="mb-12">
      <div className="flex items-baseline gap-4 mb-6 border-t border-border pt-7">
        <h3 className="font-display font-light text-2xl text-foreground">{label}</h3>
        {role
          ? <span className="font-display font-light italic text-base text-muted-strong">{role}</span>
          : <span className="font-sans text-[9px] tracking-widest uppercase text-muted">{products.length} pieces</span>}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-5">
        {products.map((p, i) => <ProductCard key={p.objectID} product={p} position={startPosition + i} userToken={userToken} />)}
      </div>
    </div>
  );
}

// ── Style DNA card ────────────────────────────────────────────────────────────

function StyleDNACard({ dna }: { dna: StyleDNA }) {
  return (
    <div className="border border-border bg-white/[0.02]">
      <div className="px-7 pt-6 pb-5 border-b border-border">
        <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">Your palette</p>
        <div className="flex flex-wrap gap-5">
          {(dna.color_palette ?? []).map((color) => (
            <div key={color} className="flex items-center gap-2.5">
              <div className="w-3.5 h-3.5 rounded-full flex-shrink-0 ring-1 ring-white/10" style={{ backgroundColor: colorToCSS(color) }} />
              <span className="font-sans text-sm text-muted-strong capitalize">{color}</span>
            </div>
          ))}
        </div>
      </div>
      {(dna.style_references ?? []).length > 0 && (
        <div className="px-7 py-5 border-b border-border">
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">Inspired by</p>
          <div className="flex flex-col gap-4">
            {dna.style_references.map((ref) => (
              <div key={ref.name}>
                <p className="font-sans text-sm text-foreground">{ref.name}<span className="text-muted ml-2 font-light">— {ref.era}</span></p>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="px-7 py-5 border-b border-border grid grid-cols-2 gap-8">
        <div>
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">Reaches for</p>
          <ul className="flex flex-col gap-2">
            {(dna.key_pieces ?? []).slice(0, 5).map((p) => (
              <li key={p} className="font-sans text-sm text-muted-strong flex items-center gap-2.5">
                <span className="w-3 h-px bg-accent/60 flex-shrink-0" />{p}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">Avoids</p>
          <ul className="flex flex-col gap-2">
            {(dna.avoids ?? []).slice(0, 4).map((a) => (
              <li key={a} className="font-sans text-sm text-muted flex items-center gap-2.5">
                <span className="w-3 h-px bg-muted/30 flex-shrink-0" />{a}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {dna.occasion_mix && (
        <div className="px-7 py-5">
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">Where you wear it</p>
          <div className="flex h-px w-full overflow-hidden gap-px">
            {dna.occasion_mix.casual    > 0 && <div style={{ width: `${dna.occasion_mix.casual}%`    }} className="bg-foreground" />}
            {dna.occasion_mix.work      > 0 && <div style={{ width: `${dna.occasion_mix.work}%`      }} className="bg-foreground/50" />}
            {dna.occasion_mix.weekend   > 0 && <div style={{ width: `${dna.occasion_mix.weekend}%`   }} className="bg-foreground/30" />}
            {dna.occasion_mix.going_out > 0 && <div style={{ width: `${dna.occasion_mix.going_out}%` }} className="bg-foreground/15" />}
          </div>
          <div className="flex gap-7 mt-3 flex-wrap">
            {[
              { label: "Casual", pct: dna.occasion_mix.casual },
              { label: "Work", pct: dna.occasion_mix.work },
              { label: "Weekend", pct: dna.occasion_mix.weekend },
              { label: "Going out", pct: dna.occasion_mix.going_out },
            ].filter(({ pct }) => pct > 0).map(({ label, pct }) => (
              <p key={label} className="font-sans text-[11px] text-muted">
                <span className="font-medium text-foreground/80">{pct}%</span>{" "}{label}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Product scroll card ───────────────────────────────────────────────────────

function ProductScrollCard({
  product, index, activeIdx, userToken, onSayMore,
}: {
  product:    AlgoliaProduct;
  index:      number;
  activeIdx:  number;
  userToken:  string;
  onSayMore?: (comment: string) => void;
}) {
  const price  = product.price != null ? formatPrice(product.price) : null;
  const isNear = Math.abs(index - activeIdx) <= 2;
  const [liked, setLiked]             = useState(false);
  const [showSayMore, setShowSayMore] = useState(false);
  const [sayMoreText, setSayMoreText] = useState("");

  const handleProductClick = () => {
    trackProductClick({ userToken, objectID: product.objectID, queryID: product._queryID ?? "", position: index + 1 });
    fetch("/api/taste/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userToken, product: { objectID: product.objectID, title: product.title, brand: product.brand, color: product.color, category: product.category, retailer: product.retailer, price_range: product.price_range, image_url: product.image_url } }),
    }).catch(() => {});
  };

  const handleLike = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const nowLiked = !liked;
    setLiked(nowLiked);
    if (nowLiked) {
      trackProductClick({ userToken, objectID: product.objectID, queryID: product._queryID ?? "", position: index + 1 });
      fetch("/api/taste/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken, product: { objectID: product.objectID, title: product.title, brand: product.brand, color: product.color, category: product.category, retailer: product.retailer, price_range: product.price_range, image_url: product.image_url } }),
      }).catch(() => {});
    }
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
      onClick={handleProductClick}
      className="relative flex flex-col bg-background block"
      style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}
      data-card-index={index}
    >
      {/* Full-bleed image */}
      <div className="absolute inset-0 bg-white/5">
        {product.image_url ? (
          <Image src={product.image_url} alt={product.title} fill className="object-cover" unoptimized priority={isNear} sizes="100vw" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted/20 font-display text-6xl">▢</div>
        )}
      </div>

      {/* Retailer label */}
      <div className="absolute top-14 left-4 z-10 pointer-events-none">
        <span className="font-sans text-[8px] tracking-widest uppercase text-white/40">{product.retailer}</span>
      </div>

      {/* Right rail — like + steer */}
      <div className="absolute right-4 bottom-40 z-20 flex flex-col items-center gap-5">
        {/* Like */}
        <button onClick={handleLike} className="flex flex-col items-center gap-1.5 active:scale-90 transition-transform" aria-label={liked ? "Unlike" : "Like"}>
          <div className="w-14 h-14 rounded-full bg-black flex items-center justify-center">
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

        {/* Steer */}
        {onSayMore && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowSayMore((v) => !v); }}
            className="flex flex-col items-center gap-1.5 active:scale-90 transition-transform"
            aria-label="Steer"
          >
            <div className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors duration-150 ${showSayMore ? "bg-white" : "bg-black"}`}>
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

      {/* Say more input */}
      {showSayMore && (
        <form
          onSubmit={handleSayMoreSubmit}
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-24 left-3 right-3 z-30"
        >
          <div className="flex gap-2">
            <input
              autoFocus
              value={sayMoreText}
              onChange={(e) => setSayMoreText(e.target.value)}
              placeholder="more minimalist… no florals… show me bags…"
              className="flex-1 bg-background/90 backdrop-blur-sm border border-border/60 px-3 py-2 font-sans text-xs text-foreground placeholder-muted/60 focus:outline-none"
            />
            <button type="submit" className="px-3 py-2 bg-foreground text-background font-sans text-[9px] tracking-widest uppercase whitespace-nowrap">→</button>
          </div>
        </form>
      )}

      {/* Bottom overlay */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-4 py-6 bg-gradient-to-t from-background via-background/70 to-transparent">
        {product.brand && <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1">{product.brand}</p>}
        <p className="font-display font-light text-xl text-foreground leading-snug mb-1">{product.title}</p>
        {price && <p className="font-sans text-sm text-muted-strong mb-3">{price}</p>}
        <span className="inline-block font-sans text-[9px] tracking-widest uppercase text-foreground border-b border-foreground/30 pb-px">Shop →</span>
      </div>
    </a>
  );
}

// ── Product scroll view ───────────────────────────────────────────────────────

function ProductScrollView({
  products, onClose, userToken, onSayMore,
}: {
  products:   AlgoliaProduct[];
  onClose:    () => void;
  userToken:  string;
  onSayMore?: (comment: string) => void;
}) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const isScrolling   = useRef(false);

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
      <div className="relative flex flex-col overflow-hidden rounded-sm shadow-2xl"
        style={{ width: "min(88vw, 400px)", height: "min(88vh, 720px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-background/90 to-transparent pointer-events-none">
          <button onClick={onClose} className="pointer-events-auto font-sans text-[9px] tracking-widest uppercase text-foreground/60 hover:text-foreground transition-colors">← Grid</button>
          <span className="font-sans text-[9px] tracking-widest uppercase text-foreground/30">{activeIdx + 1} / {products.length}</span>
        </div>
        <div ref={containerRef} onScroll={handleScroll} className="w-full h-full overflow-y-scroll" style={{ scrollSnapType: "y mandatory" }}>
          {products.map((p, i) => (
            <ProductScrollCard key={p.objectID} product={p} index={i} activeIdx={activeIdx} userToken={userToken} onSayMore={onSayMore} />
          ))}
        </div>
        {activeIdx === 0 && products.length > 1 && (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1 pointer-events-none animate-bounce">
            <span className="font-sans text-[8px] tracking-widest uppercase text-white/20">scroll</span>
            <span className="text-white/20 text-xs">↓</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Outfit scroll card ────────────────────────────────────────────────────────

function OutfitScrollCard({
  card, index, onLike, onSayMore, userToken,
}: {
  card:       OutfitCard;
  index:      number;
  onLike:     () => void;
  onSayMore?: (comment: string) => void;
  userToken:  string;
}) {
  const cols = card.products.length === 1 ? 1 : card.products.length === 2 ? 2 : 3;
  const [showSayMore, setShowSayMore] = useState(false);
  const [sayMoreText, setSayMoreText] = useState("");

  const hasNewProduct = card.products.some((p) => {
    const sa = (p as { scraped_at?: string }).scraped_at;
    return sa && (Date.now() - new Date(sa).getTime()) < 7 * 24 * 60 * 60 * 1000;
  });

  const handleSayMoreSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const trimmed = sayMoreText.trim();
    if (trimmed) { onSayMore?.(trimmed); setSayMoreText(""); setShowSayMore(false); }
  };

  return (
    <div className="relative flex flex-col bg-background" style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start", scrollSnapStop: "always" }} data-card-index={index}>
      <div className="flex-1 grid gap-px overflow-hidden" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {card.products.map((p) => (
          <a key={p.objectID} href={p.product_url || "#"} target="_blank" rel="noopener noreferrer"
            className="relative overflow-hidden bg-white/5 group"
            onClick={() => trackProductClick({ userToken, objectID: p.objectID, queryID: p._queryID ?? "", position: 1 })}>
            {p.image_url ? (
              <Image src={p.image_url} alt={p.title} fill className="object-cover group-hover:scale-[1.03] transition-transform duration-700" unoptimized sizes="33vw" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-muted/20 font-display text-5xl">▢</div>
            )}
          </a>
        ))}
      </div>

      <div className="absolute top-16 left-5 z-10 pointer-events-none">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="font-sans text-[8px] tracking-widest uppercase text-white/40">{card.label}</p>
          {hasNewProduct && (
            <span className="font-sans text-[7px] tracking-widest uppercase bg-accent text-background px-1.5 py-0.5">New</span>
          )}
        </div>
        {card.role && <p className="font-display italic text-lg text-white/80 drop-shadow-sm">{card.role}</p>}
      </div>

      {/* TikTok-style right rail */}
      <div className="absolute right-4 bottom-40 z-10 flex flex-col items-center gap-5">
        {/* Like */}
        <button onClick={onLike} className="flex flex-col items-center gap-1.5 active:scale-90 transition-transform">
          <div className="w-14 h-14 rounded-full bg-black flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-[26px] h-[26px]"
              fill={card.liked ? "#FF2D55" : "none"}
              stroke={card.liked ? "#FF2D55" : "white"}
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
          </div>
          <span className="font-sans text-[11px] font-semibold text-white" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}>
            {card.liked ? "Liked" : "Like"}
          </span>
        </button>

        {/* Steer */}
        {onSayMore && (
          <button onClick={(e) => { e.stopPropagation(); setShowSayMore((v) => !v); }}
            className="flex flex-col items-center gap-1.5 active:scale-90 transition-transform">
            <div className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors duration-150 ${showSayMore ? "bg-white" : "bg-black"}`}>
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

      {/* Say more input */}
      {showSayMore && (
        <form onSubmit={handleSayMoreSubmit} onClick={(e) => e.stopPropagation()} className="absolute bottom-28 left-4 right-16 z-30">
          <div className="flex gap-2">
            <input autoFocus value={sayMoreText} onChange={(e) => setSayMoreText(e.target.value)}
              placeholder="more minimal… show shoes… different vibe…"
              className="flex-1 bg-background/90 backdrop-blur-sm border border-border/60 px-3 py-2 font-sans text-xs text-foreground placeholder-muted/60 focus:outline-none" />
            <button type="submit" className="px-3 py-2 bg-foreground text-background font-sans text-[9px] tracking-widest uppercase">→</button>
          </div>
        </form>
      )}

      <div className="absolute bottom-0 left-0 right-16 z-10 px-5 py-6 bg-gradient-to-t from-background/90 via-background/50 to-transparent">
        <div className="flex flex-col gap-2">
          {card.products.map((p) => (
            <a key={p.objectID} href={p.product_url || "#"} target="_blank" rel="noopener noreferrer" className="group/item">
              <p className="font-sans text-xs text-foreground/90 line-clamp-1 group-hover/item:text-accent transition-colors">{p.title}</p>
              <p className="font-sans text-[10px] text-muted">{p.brand}{p.price != null ? ` · ${formatPrice(p.price)}` : ""}</p>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Outfit scroll view ────────────────────────────────────────────────────────

function OutfitScrollView({
  cards, onLike, onNearEnd, isGeneratingMore, catalogExhausted, onClose, userToken, onSayMore, onActiveChange, onDwell,
}: {
  cards:             OutfitCard[];
  onLike:            (cardId: string) => void;
  onNearEnd:         () => void;
  isGeneratingMore:  boolean;
  catalogExhausted:  boolean;
  onClose:           () => void;
  userToken:         string;
  onSayMore?:        (comment: string) => void;
  onActiveChange?:   (idx: number) => void;
  onDwell?:          (cardId: string, ms: number) => void;
}) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const nearEndFired  = useRef(false);
  const isScrolling   = useRef(false);
  // Dwell tracking
  const cardEnteredAt = useRef<number>(Date.now());
  const prevIdxRef    = useRef<number>(0);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, clientHeight } = containerRef.current;
    const idx = Math.round(scrollTop / clientHeight);

    // Card changed → report dwell for the card we just left
    if (idx !== prevIdxRef.current) {
      const leaving = cards[prevIdxRef.current];
      if (leaving) onDwell?.(leaving.id, Date.now() - cardEnteredAt.current);
      cardEnteredAt.current = Date.now();
      prevIdxRef.current    = idx;
    }

    setActiveIdx(idx);
    onActiveChange?.(idx);
    if (!nearEndFired.current && idx >= cards.length - 4) { nearEndFired.current = true; onNearEnd(); }
  }, [cards, onNearEnd, onActiveChange, onDwell]);

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

  // Keyboard navigation: ↑/↓ (or k/j) to move, space / PageDown also advance,
  // l to like the current card, Esc to exit. Skips when typing in an input.
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
        case "l": {
          const current = cards[activeIdx];
          if (current) { e.preventDefault(); onLike(current.id); }
          break;
        }
        case "Escape":
          e.preventDefault(); onClose(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards, activeIdx, onLike, onClose]);

  useEffect(() => { nearEndFired.current = false; }, [cards.length]);

  useEffect(() => {
    cards.slice(activeIdx + 1, activeIdx + 3).forEach((card) => {
      card.products.forEach((p) => { if (!p.image_url) return; const img = new window.Image(); img.src = p.image_url; });
    });
  }, [activeIdx, cards]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="relative flex flex-col overflow-hidden rounded-sm shadow-2xl"
        style={{ width: "min(88vw, 400px)", height: "min(88vh, 720px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-background/90 to-transparent pointer-events-none">
          <button onClick={onClose} className="pointer-events-auto font-sans text-[9px] tracking-widest uppercase text-foreground/60 hover:text-foreground transition-colors">← Grid</button>
          <span className="font-sans text-[9px] tracking-widest uppercase text-foreground/30">{activeIdx + 1} / {cards.length}</span>
        </div>
        <div ref={containerRef} onScroll={handleScroll} className="w-full h-full overflow-y-scroll" style={{ scrollSnapType: "y mandatory" }}>
          {cards.map((card, i) => (
            <OutfitScrollCard key={card.id} card={card} index={i} onLike={() => onLike(card.id)} onSayMore={onSayMore} userToken={userToken} />
          ))}
          {isGeneratingMore && (
            <div className="flex items-center justify-center bg-background" style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}>
              <p className="font-display italic text-xl text-muted">Loading more outfits<span className="inline-flex ml-0.5">
                <span style={{ animation: "dotPulse 1.4s ease-in-out 0s infinite" }}>.</span>
                <span style={{ animation: "dotPulse 1.4s ease-in-out 0.28s infinite" }}>.</span>
                <span style={{ animation: "dotPulse 1.4s ease-in-out 0.56s infinite" }}>.</span>
              </span></p>
            </div>
          )}
          {!isGeneratingMore && catalogExhausted && cards.length > 0 && (
            <div className="flex flex-col items-center justify-center bg-background gap-4" style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}>
              <p className="font-display italic text-xl text-muted">You've seen everything in this aesthetic.</p>
              <p className="font-sans text-[10px] tracking-widest uppercase text-muted/70">Refine via "say more" or start a new search</p>
            </div>
          )}
        </div>
        {activeIdx === 0 && cards.length > 1 && (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1 pointer-events-none animate-bounce">
            <span className="font-sans text-[8px] tracking-widest uppercase text-white/20">scroll</span>
            <span className="text-white/20 text-xs">↓</span>
          </div>
        )}
      </div>
    </div>
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
                Build my edit →
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

const EDIT_STEPS = [
  { label: "Shortlisting finalists",  sub: "Narrowing to the strongest fits" },
  { label: "Seeing the products",     sub: "Claude views each image, builds outfits" },
  { label: "Writing your edit",       sub: "Styling notes & editorial intro" },
];

const CATEGORIES = ["dress", "top", "bottom", "jacket", "shoes", "bag"] as const;

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { data: session } = useSession();

  // Onboarding
  const [onboardingDone, setOnboardingDone] = useState(false);

  useEffect(() => {
    setOnboardingDone(!!localStorage.getItem("muse_onboarding_v1"));
  }, []);

  // Core state
  const [step, setStep]                     = useState<Step>("boards");
  const [boards, setBoards]                 = useState<Board[]>([]);
  const [boardsLoading, setBoardsLoading]   = useState(true);
  const [selectedBoard, setSelectedBoard]   = useState<Board | null>(null);
  const [pins, setPins]                     = useState<PinData[]>([]);
  const [pinsLoading, setPinsLoading]       = useState(false);
  const [aesthetic, setAesthetic]           = useState<StyleDNA | null>(null);
  const [candidates, setCandidates]         = useState<CategoryCandidates | null>(null);
  const [products, setProducts]             = useState<CuratedProduct[]>([]);
  const [editorialIntro, setEditorialIntro] = useState("");
  const [editRationale, setEditRationale]   = useState("");
  const [outfitArc, setOutfitArc]           = useState("");
  const [outfitARole, setOutfitARole]       = useState("");
  const [outfitBRole, setOutfitBRole]       = useState("");
  const [shoppingStep, setShoppingStep]     = useState(0);
  const [editStep, setEditStep]             = useState(0);
  const [errorMsg, setErrorMsg]             = useState("");
  const [userToken, setUserToken]           = useState("anon");
  const [viewMode, setViewMode]             = useState<ViewMode>("scroll");
  const [shopViewMode, setShopViewMode]     = useState<ViewMode>("scroll");
  const [scrollCards, setScrollCards]       = useState<OutfitCard[]>([]);
  const [isGeneratingMore, setIsGeneratingMore] = useState(false);

  // Multi-context blocks (up to 4, each independently typed)
  interface ContextBlock {
    id:            string;
    type:          InputMode;
    textQuery:     string;
    uploadedFiles: Array<{ url: string; file: File }>;
    answers?:      QuestionnaireAnswers;
  }
  const [contextBlocks, setContextBlocks]   = useState<ContextBlock[]>([
    { id: "b1", type: "pinterest", textQuery: "", uploadedFiles: [] },
  ]);
  const [isRefining, setIsRefining]         = useState(false);

  // Session feedback loop
  const [sessionLikedIds, setSessionLikedIds] = useState<string[]>([]);
  const [sessionId] = useState(() => Math.random().toString(36).slice(2));
  const activeScrollIdxRef = useRef(0); // tracks current card in TikTok scroll

  // ── "More like this" injection on like ────────────────────────────────────
  // Single-flight: if a previous fetch is in-flight, ignore further likes
  // until it returns. Prevents 5 rapid likes from spawning 5 Claude calls.
  const isFetchingSimilarRef = useRef(false);

  // ── TikTok scoring ────────────────────────────────────────────────────────
  // dwellTimes: ms spent on each card (card.id → ms); used to compute session
  // engagement multiplier and re-rank upcoming cards.
  const [dwellTimes, setDwellTimes] = useState<Record<string, number>>({});
  // click history loaded from taste memory at shop time (cross-session signal)
  const clickHistoryRef = useRef<ClickSignalLike[]>([]);
  // disliked signals — attributes of cards the user scrolled past very fast
  // (<700ms). Capped at 40 to avoid unbounded growth across a session.
  const dislikedSignalsRef = useRef<ClickSignalLike[]>([]);

  const buildSignals = useCallback((): ScoringSignals => ({
    likedProductIds: new Set(sessionLikedIds),
    clickHistory:    clickHistoryRef.current,
    dislikedSignals: dislikedSignalsRef.current,
    dwellTimes,
    aestheticPrice:  aesthetic?.price_range ?? "mid",
  }), [sessionLikedIds, dwellTimes, aesthetic]);

  // Called when the user scrolls past a card — ms = time spent on it.
  // Fast swipe = implicit dislike; long linger = implicit like.
  // On strong signals, re-rank the upcoming queue.
  const handleDwell = useCallback((cardId: string, ms: number) => {
    setDwellTimes((prev) => ({ ...prev, [cardId]: ms }));
    const signal = interpretDwell(ms);
    if (signal !== "strong_positive" && signal !== "negative") return;

    // Capture negative signals: if the user scrolled past this card fast AND
    // didn't explicitly like it, remember its products' attributes so similar
    // upcoming cards get penalized.
    setScrollCards((prev) => {
      if (signal === "negative") {
        const leaving = prev.find((c) => c.id === cardId);
        if (leaving && !leaving.liked) {
          const newDislikes: ClickSignalLike[] = leaving.products.map((p) => ({
            objectID:    p.objectID,
            category:    p.category ?? "",
            brand:       p.brand ?? "",
            color:       p.color ?? "",
            price_range: p.price_range ?? "mid",
            retailer:    p.retailer,
          }));
          dislikedSignalsRef.current = [...newDislikes, ...dislikedSignalsRef.current].slice(0, 40);
        }
      }

      // Re-rank upcoming cards so the algorithm reflects the fresh signal
      const signals: ScoringSignals = {
        likedProductIds: new Set(sessionLikedIds),
        clickHistory:    clickHistoryRef.current,
        dislikedSignals: dislikedSignalsRef.current,
        dwellTimes:      { ...dwellTimes, [cardId]: ms },
        aestheticPrice:  aesthetic?.price_range ?? "mid",
      };
      return reRankUpcoming(prev, activeScrollIdxRef.current, signals);
    });
  }, [sessionLikedIds, dwellTimes, aesthetic]);

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

  useEffect(() => {
    if (step === "results" && products.length > 0) {
      trackProductsViewed({ userToken, objectIDs: products.map((p) => p.objectID) });
    }
  }, [step, products, userToken]);

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
    const t1 = setTimeout(() => setShoppingStep(1), 15000);
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

      if (contexts.length === 0) { setStep("boards"); return; }

      const res = await fetch("/api/shop", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ contexts, userToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? "Shop failed");
      setAesthetic(data.aesthetic);
      setCandidates(data.candidates);
      // Seed scoring engine with cross-session click history
      if (Array.isArray(data.clickSignals)) {
        clickHistoryRef.current = data.clickSignals.map((s: { object_id?: string; objectID?: string; category: string; brand: string; color: string; price_range: string; retailer?: string }) => ({
          objectID: s.object_id ?? s.objectID,
          category: s.category,
          brand:    s.brand,
          color:    s.color,
          price_range: s.price_range,
          retailer: s.retailer,
        }));
      }
      setStep("shopping");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong.");
      setStep("error");
    } finally { clearTimeout(t1); }
  }, [contextBlocks, selectedBoard, pins, userToken]);

  // ── Shop handlers ─────────────────────────────────────────────────────────


  // ── Build edit ────────────────────────────────────────────────────────────

  // Helper: call /api/curate once and return outfit cards (or [])
  const curateBatch = useCallback(async (label: string): Promise<OutfitCard[]> => {
    const ts = Date.now() + Math.random(); // unique id
    const res = await fetch("/api/curate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aesthetic, candidates, boardId: selectedBoard?.id, boardName: selectedBoard?.name, userToken }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const ps: CuratedProduct[] = data.products ?? [];
    const cards: OutfitCard[] = [];
    const a = ps.filter((p) => p.outfit_group === "outfit_a");
    const b = ps.filter((p) => p.outfit_group === "outfit_b");
    if (a.length) cards.push({ id: `a-${label}-${ts}`, label: "Outfit A", role: data.outfit_a_role ?? "", products: a, liked: false });
    if (b.length) cards.push({ id: `b-${label}-${ts}`, label: "Outfit B", role: data.outfit_b_role ?? "", products: b, liked: false });
    return cards;
  }, [aesthetic, candidates, selectedBoard, userToken]);

  const handleBuildEdit = useCallback(async (isAppend = false) => {
    if (!aesthetic || !candidates) return;
    setStep("edit_loading");
    setEditStep(0);
    // Fresh shot at the catalog — a new regenerate is allowed to re-fetch
    // more candidates even if a previous run had exhausted the pool.
    setCatalogExhausted(false);
    const t1 = setTimeout(() => setEditStep(1), 8000);
    const t2 = setTimeout(() => setEditStep(2), 16000);
    try {
      // Primary call — also sets editorial/grid data
      const res = await fetch("/api/curate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aesthetic, candidates, boardId: selectedBoard?.id, boardName: selectedBoard?.name, userToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? "Curation failed");

      const ps: CuratedProduct[] = data.products ?? [];
      setProducts(ps);
      setEditorialIntro(data.editorial_intro ?? "");
      setEditRationale(data.edit_rationale ?? "");
      setOutfitArc(data.outfit_arc ?? "");
      setOutfitARole(data.outfit_a_role ?? "");
      setOutfitBRole(data.outfit_b_role ?? "");

      // Build first 2 cards from primary response
      const ts = Date.now();
      const firstCards: OutfitCard[] = [];
      const a0 = ps.filter((p) => p.outfit_group === "outfit_a");
      const b0 = ps.filter((p) => p.outfit_group === "outfit_b");
      if (a0.length) firstCards.push({ id: `a-0-${ts}`, label: "Outfit A", role: data.outfit_a_role ?? "", products: a0, liked: false });
      if (b0.length) firstCards.push({ id: `b-0-${ts}`, label: "Outfit B", role: data.outfit_b_role ?? "", products: b0, liked: false });

      // Show results immediately with first 2 cards
      setScrollCards(isAppend ? (prev) => [...prev, ...firstCards] : firstCards);
      setStep("results");

      // Fire 2 more batches in background to build up a pool the algorithm can rank
      const [batch2, batch3] = await Promise.all([curateBatch("1"), curateBatch("2")]);
      const morePools = [...batch2, ...batch3].filter((c) => c.products.length > 0);

      // Dedup: drop any card whose product set is already in firstCards
      const seenKeys = new Set(firstCards.map((c) => c.products.map((p) => p.objectID).sort().join(",")));
      const fresh = morePools.filter((c) => {
        const key = c.products.map((p) => p.objectID).sort().join(",");
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      if (fresh.length > 0) {
        // Rank the combined upcoming pool and append
        const signals = buildSignals();
        const ranked = rankCards(fresh, signals);
        setScrollCards((prev) => [...prev, ...ranked]);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong.");
      setStep("error");
    } finally { clearTimeout(t1); clearTimeout(t2); }
  }, [aesthetic, candidates, selectedBoard, userToken, curateBatch, buildSignals]);

  // Once the catalog has no more fresh products matching this aesthetic, flip
  // this flag to true so we stop trying. Resets when the user starts a new
  // search or regenerates. State (not ref) so UI can react.
  const [catalogExhausted, setCatalogExhausted] = useState(false);

  const handleGenerateMore = useCallback(async () => {
    if (!aesthetic || !candidates || isGeneratingMore || catalogExhausted) return;
    setIsGeneratingMore(true);
    try {
      // Collect every objectID already in the scroll queue OR the candidates
      // buffer — server excludes these so we get genuinely new products.
      const shownFromScroll     = scrollCards.flatMap((c) => c.products.map((p) => p.objectID));
      const shownFromCandidates = CATEGORIES.flatMap((c) => candidates[c].map((p) => p.objectID));
      const excludeIds = Array.from(new Set([...shownFromScroll, ...shownFromCandidates]));

      const res = await fetch("/api/more-outfits", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ aesthetic, excludeIds, userToken }),
      });
      if (!res.ok) return;
      const data = await res.json();

      if (data.exhausted) {
        console.log("[more-outfits] catalog exhausted for this aesthetic");
        setCatalogExhausted(true);
        return;
      }

      const batches = (data.batches ?? []) as Array<{
        products:      CuratedProduct[];
        outfit_a_role: string;
        outfit_b_role: string;
      }>;
      if (batches.length === 0) return;

      // Flatten batches into OutfitCards
      const ts = Date.now();
      const newCards: OutfitCard[] = [];
      batches.forEach((batch, bIdx) => {
        const a = batch.products.filter((p) => p.outfit_group === "outfit_a");
        const b = batch.products.filter((p) => p.outfit_group === "outfit_b");
        if (a.length) newCards.push({ id: `mo-a-${bIdx}-${ts}`, label: "Outfit A", role: batch.outfit_a_role, products: a, liked: false });
        if (b.length) newCards.push({ id: `mo-b-${bIdx}-${ts}`, label: "Outfit B", role: batch.outfit_b_role, products: b, liked: false });
      });

      // Dedup against existing scroll cards (by product-set key)
      setScrollCards((prev) => {
        const seenKeys = new Set(prev.map((c) => c.products.map((p) => p.objectID).sort().join(",")));
        const fresh = newCards.filter((c) => {
          const key = c.products.map((p) => p.objectID).sort().join(",");
          if (seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        });
        if (fresh.length === 0) return prev;
        const ranked = rankCards(fresh, buildSignals());
        return [...prev, ...ranked];
      });
    } finally { setIsGeneratingMore(false); }
  }, [aesthetic, candidates, isGeneratingMore, catalogExhausted, scrollCards, userToken, buildSignals]);

  // ── Session feedback: "say more" ──────────────────────────────────────────

  const handleSayMore = useCallback(async (comment: string) => {
    if (!aesthetic || isRefining) return;
    setIsRefining(true);
    try {
      // Compute the upcoming queue's product IDs so the server can prune
      // them based on whether they still fit the refined direction.
      const insertAt = activeScrollIdxRef.current + 1;
      const upcomingProductIds = scrollCards
        .slice(insertAt)
        .flatMap((c) => c.products.map((p) => p.objectID))
        .slice(0, 16); // limit for vision-call cost

      const res = await fetch("/api/refine", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          comment,
          upcomingProductIds,
          currentAesthetic: aesthetic,
          userToken,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn("[refine] non-ok:", res.status, body);
        return;
      }
      const data = await res.json();
      console.log(`[refine] intent="${data.intent ?? ""}" keep=${(data.keepIds ?? []).length} newCandidates=${data.candidates ? Object.values(data.candidates).reduce((s: number, arr) => s + (arr as unknown[]).length, 0) : 0}`);

      const newAesthetic = data.aesthetic ?? aesthetic;
      if (data.aesthetic) setAesthetic(data.aesthetic);

      // Server returned the IDs of upcoming items that still fit the new vibe.
      // Everything else upcoming will be wiped.
      const keepSet: Set<string> = new Set(data.keepIds ?? []);

      const newCandidates = data.candidates;
      if (newCandidates) {
        // Refresh the global candidates buffer (used for "load more" later)
        setCandidates((prev) => {
          if (!prev) return newCandidates;
          const seenIds = new Set(CATEGORIES.flatMap((c) => prev[c].map((p) => p.objectID)));
          const merged = { ...prev };
          for (const cat of CATEGORIES) {
            const newItems = (newCandidates[cat] ?? []).filter((p: { objectID: string }) => !seenIds.has(p.objectID));
            merged[cat] = [...prev[cat], ...newItems];
          }
          return merged;
        });

        // Curate the refined candidates into outfit cards
        const curateRes = await fetch("/api/curate", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ aesthetic: newAesthetic, candidates: newCandidates, userToken }),
        });
        if (curateRes.ok) {
          const curateData = await curateRes.json();
          const ps: CuratedProduct[] = curateData.products ?? [];
          const ts = Date.now();
          const a = ps.filter((p) => p.outfit_group === "outfit_a");
          const b = ps.filter((p) => p.outfit_group === "outfit_b");
          const newCards: OutfitCard[] = [];
          if (a.length) newCards.push({ id: `say-a-${ts}`, label: "Refined edit", role: curateData.outfit_a_role ?? "", products: a, liked: false });
          if (b.length) newCards.push({ id: `say-b-${ts}`, label: "Refined edit", role: curateData.outfit_b_role ?? "", products: b, liked: false });

          // ── DRAMATIC REPLACEMENT ────────────────────────────────────────────
          // Wipe upcoming queue, keep only items the user has already swiped
          // through plus the cards Claude said still fit. Then drop the
          // freshly-refined cards in front. The next swipe lands on the new
          // direction — comments now feel like they actually did something.
          const signals = buildSignals();
          const rankedNew = newCards.length > 0 ? rankCards(newCards, signals) : [];

          setScrollCards((prev) => {
            const seen = prev.slice(0, insertAt);
            const upcoming = prev.slice(insertAt);

            // Keep upcoming cards whose products are mostly still in the keep set
            const keptUpcoming = upcoming.filter((card) => {
              const total = card.products.length;
              if (total === 0) return false;
              const surviving = card.products.filter((p) => keepSet.has(p.objectID)).length;
              return surviving / total >= 0.5; // keep if at least half its items still fit
            });

            // New refined cards first (so user sees the change immediately),
            // then any upcoming cards that survived the pruning, all re-ranked.
            const next = [...seen, ...rankedNew, ...keptUpcoming];
            const afterInsert = insertAt + rankedNew.length;
            return reRankUpcoming(next, Math.max(0, afterInsert - 1), signals);
          });
        }
      }
    } catch (err) {
      console.warn("[handleSayMore] failed:", err);
    } finally {
      setIsRefining(false);
    }
  }, [aesthetic, scrollCards, userToken, isRefining, buildSignals]);

  // ── Like card ─────────────────────────────────────────────────────────────

  /**
   * Fire the /api/similar-on-like endpoint with the just-liked products,
   * then inject the returned outfit cards just after the user's current
   * scroll position. Async — the user keeps swiping while this loads.
   */
  const injectSimilarOnLike = useCallback(async (
    likedProductIds: string[],
  ) => {
    if (!aesthetic || likedProductIds.length === 0) return;
    if (isFetchingSimilarRef.current) return;       // single-flight
    isFetchingSimilarRef.current = true;
    try {
      // Exclude every product currently in the queue so we don't insert dupes
      const excludeIds = scrollCards.flatMap((c) => c.products.map((p) => p.objectID));

      const res = await fetch("/api/similar-on-like", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ likedProductIds, aesthetic, userToken, excludeIds }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn("[similar-on-like] non-ok:", res.status, body);
        return;
      }
      const data = await res.json();
      const ps: CuratedProduct[] = data.products ?? [];
      console.log(`[similar-on-like] got ${ps.length} products, building cards…`);
      if (ps.length === 0) return;

      // Build outfit cards from returned products (mirrors handleSayMore)
      const ts = Date.now();
      const a  = ps.filter((p) => p.outfit_group === "outfit_a");
      const b  = ps.filter((p) => p.outfit_group === "outfit_b");
      const newCards: OutfitCard[] = [];
      if (a.length) newCards.push({ id: `like-a-${ts}`, label: "More like this", role: data.outfit_a_role ?? "", products: a, liked: false });
      if (b.length) newCards.push({ id: `like-b-${ts}`, label: "More like this", role: data.outfit_b_role ?? "", products: b, liked: false });
      if (newCards.length === 0) return;

      // Insert just after the user's current scroll position so the next
      // swipe lands on "more like this" — visceral, immediate.
      const signals    = buildSignals();
      const rankedNew  = rankCards(newCards, signals);
      setScrollCards((prev) => {
        const insertAt    = activeScrollIdxRef.current + 1;
        const withInserted = [...prev.slice(0, insertAt), ...rankedNew, ...prev.slice(insertAt)];
        const afterInsert  = insertAt + rankedNew.length;
        return reRankUpcoming(withInserted, afterInsert - 1, signals);
      });
    } catch (err) {
      console.warn("[injectSimilarOnLike] failed:", err);
    } finally {
      isFetchingSimilarRef.current = false;
    }
  }, [aesthetic, scrollCards, userToken, buildSignals]);

  const handleLikeCard = useCallback((cardId: string) => {
    let likedNow: string[] = [];   // captured for the async similar-fetch
    setScrollCards((prev) => {
      const targetCard = prev.find((c) => c.id === cardId);
      const becomingLiked = targetCard != null && !targetCard.liked;
      if (becomingLiked) likedNow = targetCard.products.map((p) => p.objectID);

      const updated = prev.map((c) => {
        if (c.id !== cardId) return c;
        const nowLiked = !c.liked;
        if (nowLiked) {
          const ids = c.products.map((p) => p.objectID);
          // Update click history ref immediately so scoring picks it up
          const newSignals = c.products.map((p): ClickSignalLike => ({
            objectID: p.objectID, category: p.category ?? "", brand: p.brand ?? "",
            color: p.color ?? "", price_range: p.price_range ?? "mid", retailer: p.retailer,
          }));
          clickHistoryRef.current = [...newSignals, ...clickHistoryRef.current].slice(0, 30);
          setSessionLikedIds((s) => Array.from(new Set([...s, ...ids])));
          c.products.forEach((p) => {
            trackProductClick({ userToken, objectID: p.objectID, queryID: p._queryID ?? "", position: 1 });
            fetch("/api/taste/click", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userToken, product: { objectID: p.objectID, title: p.title, brand: p.brand, color: p.color, category: p.category, retailer: p.retailer, price_range: p.price_range, image_url: p.image_url } }),
            }).catch(() => {});
          });
        }
        return { ...c, liked: nowLiked };
      });
      // After a like, re-rank the upcoming queue with updated signals
      const signals: ScoringSignals = {
        likedProductIds: new Set(updated.filter((c) => c.liked).flatMap((c) => c.products.map((p) => p.objectID))),
        clickHistory:    clickHistoryRef.current,
        dislikedSignals: dislikedSignalsRef.current,
        dwellTimes,
        aestheticPrice:  aesthetic?.price_range ?? "mid",
      };
      return reRankUpcoming(updated, activeScrollIdxRef.current, signals);
    });

    // Fire the "more like this" injection async — non-blocking, single-flight.
    if (likedNow.length > 0) {
      void injectSimilarOnLike(likedNow);
    }
  }, [userToken, dwellTimes, aesthetic, injectSimilarOnLike]);

  // ── Session end: persist style centroid ───────────────────────────────────

  useEffect(() => {
    if (step === "results" && sessionLikedIds.length > 0 && userToken !== "anon") {
      fetch("/api/taste/centroid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken, likedProductIds: sessionLikedIds }),
      }).catch(() => {});
    }
  }, [step, sessionLikedIds, userToken]);

  // ── Reset ─────────────────────────────────────────────────────────────────

  const reset = () => {
    setStep("boards");
    setSelectedBoard(null);
    setPins([]);
    setAesthetic(null);
    setCandidates(null);
    setProducts([]);
    setEditorialIntro("");
    setEditRationale("");
    setOutfitArc("");
    setOutfitARole("");
    setOutfitBRole("");
    setErrorMsg("");
    setShoppingStep(0);
    setEditStep(0);
    setViewMode("scroll");
    setShopViewMode("scroll");
    setScrollCards([]);
    setIsGeneratingMore(false);
    setContextBlocks([{ id: "b1", type: "pinterest", textQuery: "", uploadedFiles: [] }]);
    setSessionLikedIds([]);
    setIsRefining(false);
    // Reset session-only state/refs
    setCatalogExhausted(false);
    dislikedSignalsRef.current = [];
  };

  const outfitA = products.filter((p) => p.outfit_group === "outfit_a");
  const outfitB = products.filter((p) => p.outfit_group === "outfit_b");

  // ── Context block type labels ─────────────────────────────────────────────

  const BLOCK_TYPES: { mode: InputMode; label: string }[] = [
    { mode: "pinterest", label: "Pinterest" },
    { mode: "text",      label: "Describe"  },
    { mode: "images",    label: "Upload"    },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      {!onboardingDone && <OnboardingQuiz onComplete={() => setOnboardingDone(true)} />}
      <header className="px-8 py-5 border-b border-border sticky top-0 bg-background/90 backdrop-blur-md z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="font-display font-light tracking-[0.20em] text-base text-foreground hover:text-accent transition-colors duration-200">MUSE</Link>
          <div className="flex items-center gap-8">
            {isRefining && <span className="font-sans text-[10px] tracking-widest uppercase text-muted">Musing<MusingDots /></span>}
            {step === "results" && (
              <button onClick={() => setStep("shopping")} className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors">← My picks</button>
            )}
            {(step === "shopping" || step === "results") && (
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
                Start with a Pinterest board, describe your style, or upload some inspo.
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
                className="mb-8 font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors border border-dashed border-border px-5 py-2.5">
                + Add more context
              </button>
            )}

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
                Build my edit →
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

          const scored = CATEGORIES.flatMap((cat) => candidates[cat]).map((p) => {
            const haystack = [...(p.aesthetic_tags ?? []), (p.title ?? "").toLowerCase(), (p.description ?? "").toLowerCase()].join(" ");
            const score = terms.filter((t) => t.length > 2 && haystack.includes(t)).length;
            return { product: p, score };
          });
          scored.sort((a, b) => b.score - a.score);
          const sortedProducts = scored.map(({ product }) => product);

          return (
            <>
              {shopViewMode === "scroll" && (
                <ProductScrollView products={sortedProducts} onClose={() => setShopViewMode("grid")} userToken={userToken} onSayMore={handleSayMore} />
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

                <div className="flex flex-wrap gap-4 mb-10">
                  {(aesthetic.color_palette ?? []).map((color) => (
                    <div key={color} className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full ring-1 ring-white/10 flex-shrink-0" style={{ backgroundColor: colorToCSS(color) }} />
                      <span className="font-sans text-xs text-muted-strong capitalize">{color}</span>
                    </div>
                  ))}
                </div>

                <div className="mb-14 flex items-center gap-6">
                  <button onClick={() => handleBuildEdit()}
                    className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200">
                    Build my edit →
                  </button>
                  <p className="font-sans text-[11px] text-muted">Claude will style the best finds into a curated edit.</p>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5 mb-14">
                  {sortedProducts.map((product) => <ShopCard key={product.objectID} product={product} userToken={userToken} />)}
                </div>

                <div className="border-t border-border pt-7 flex items-center justify-between mt-4">
                  <p className="font-sans text-[11px] text-muted/50 max-w-sm leading-relaxed">
                    MUSE earns a small affiliate commission if you purchase, at no extra cost to you.
                  </p>
                  <button onClick={() => handleBuildEdit()}
                    className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200">
                    Build my edit →
                  </button>
                </div>
              </div>
            </>
          );
        })()}

        {/* ── Edit loading ── */}
        {step === "edit_loading" && <LoadingScreen title="Building your edit." steps={EDIT_STEPS} currentStep={editStep} />}

        {/* ── Error ── */}
        {step === "error" && (
          <div className="fade-in flex flex-col items-center justify-center py-40 text-center">
            <h2 className="font-display font-light text-3xl text-foreground mb-3">Something went wrong.</h2>
            <p className="font-sans text-base text-muted-strong mb-12 max-w-sm">{errorMsg}</p>
            <button onClick={reset} className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors">Try again</button>
          </div>
        )}

        {/* ── Edit results ── */}
        {step === "results" && aesthetic && (
          <>
            {viewMode === "scroll" && (
              <OutfitScrollView cards={scrollCards} onLike={handleLikeCard} onNearEnd={handleGenerateMore} isGeneratingMore={isGeneratingMore} catalogExhausted={catalogExhausted} onClose={() => setViewMode("grid")} userToken={userToken} onSayMore={handleSayMore} onActiveChange={(idx) => { activeScrollIdxRef.current = idx; }} onDwell={handleDwell} />
            )}

            <div className="fade-in-up">
              <div className="flex items-start justify-between mb-12 gap-6">
                <div>
                  <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-5">Personal edit</p>
                  <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight">
                    {selectedBoard?.name ?? "Your edit"}
                  </h1>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 mt-1">
                  <div className="flex border border-border overflow-hidden">
                    <button onClick={() => setViewMode("grid")}
                      className={`px-4 py-2 font-sans text-[9px] tracking-widest uppercase transition-colors duration-150 ${viewMode === "grid" ? "bg-foreground text-background" : "text-muted hover:text-foreground"}`}>
                      Grid
                    </button>
                    <button onClick={() => setViewMode("scroll")}
                      className={`px-4 py-2 font-sans text-[9px] tracking-widest uppercase transition-colors duration-150 border-l border-border ${viewMode === "scroll" ? "bg-foreground text-background" : "text-muted hover:text-foreground"}`}>
                      Scroll
                    </button>
                  </div>
                  <button onClick={() => handleBuildEdit()}
                    className="px-6 py-2.5 border border-border hover:border-foreground/60 text-foreground font-sans text-[10px] tracking-widest uppercase transition-colors duration-200">
                    Regenerate
                  </button>
                </div>
              </div>

              <div className="mb-14"><StyleDNACard dna={aesthetic} /></div>

              <OutfitSection label="Outfit A" role={outfitARole} products={outfitA} startPosition={1} userToken={userToken} />
              <OutfitSection label="Outfit B" role={outfitBRole} products={outfitB} startPosition={outfitA.length + 1} userToken={userToken} />

              {/* Load more outfits — pulls fresh catalog products, curates
                  new outfit pairs, switches to Scroll view so the newly-added
                  cards become visible. Also fires automatically when user
                  nears the end of the scroll view. */}
              {!catalogExhausted && (
                <div className="flex justify-center mb-14">
                  <button
                    onClick={() => { setViewMode("scroll"); handleGenerateMore(); }}
                    disabled={isGeneratingMore}
                    className="px-8 py-3 border border-border hover:border-foreground/60 text-foreground font-sans text-[10px] tracking-widest uppercase transition-colors duration-200 disabled:opacity-50 disabled:cursor-wait"
                  >
                    {isGeneratingMore ? "Loading…" : "Load more outfits →"}
                  </button>
                </div>
              )}
              {catalogExhausted && (
                <p className="text-center font-sans text-[10px] tracking-widest uppercase text-muted mb-14">
                  You've seen everything in this aesthetic
                </p>
              )}

              {outfitA.length === 0 && outfitB.length === 0 && products.length > 0 && (
                <div>
                  <div className="flex items-baseline justify-between mb-6 border-t border-border pt-7">
                    <h2 className="font-display font-light text-2xl text-foreground">Your curated edit</h2>
                    <p className="font-sans text-[9px] tracking-widest uppercase text-muted">{products.length} pieces</p>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-5 mb-14">
                    {products.map((p, i) => <ProductCard key={p.objectID} product={p} position={i + 1} userToken={userToken} />)}
                  </div>
                </div>
              )}

              <div className="border-t border-border pt-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
                <p className="font-sans text-[11px] text-muted/50 max-w-sm leading-relaxed">
                  MUSE earns a small affiliate commission if you purchase, at no extra cost to you.
                </p>
                <div className="flex items-center gap-6">
                  <button onClick={() => setStep("shopping")} className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors whitespace-nowrap">← My picks</button>
                  <button onClick={reset} className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors whitespace-nowrap">← New search</button>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
