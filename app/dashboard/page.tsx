"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import type { StyleDNA, CuratedProduct } from "@/lib/ai";
import type { AlgoliaProduct, CategoryCandidates } from "@/lib/algolia";
import { getUserToken, trackProductClick, trackProductsViewed } from "@/lib/insights";

// ── Types ─────────────────────────────────────────────────────────────────────

type Board     = { id: string; name: string };
type Step      = "boards" | "shopping_loading" | "shopping" | "edit_loading" | "results" | "error";
type ViewMode  = "grid" | "scroll";

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
}

// ── Color → CSS ───────────────────────────────────────────────────────────────

function colorToCSS(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("ivory") || n.includes("off-white") || n.includes("oatmeal")) return "#FAF3E0";
  if (n.includes("cream")) return "#FFF8DC";
  if (n.includes("white")) return "#F8F8F0";
  if (n.includes("black")) return "#1C1C1C";
  if (n.includes("charcoal")) return "#404040";
  if (n.includes("grey") || n.includes("gray")) return "#9E9E9E";
  if (n.includes("navy")) return "#1C2E4A";
  if (n.includes("cobalt") || n.includes("royal blue")) return "#2563EB";
  if (n.includes("slate blue") || n.includes("dusty blue")) return "#6A8CAF";
  if (n.includes("powder blue") || n.includes("sky")) return "#87CEEB";
  if (n.includes("blue")) return "#60A5FA";
  if (n.includes("teal")) return "#2DD4BF";
  if (n.includes("camel")) return "#C19A6B";
  if (n.includes("caramel")) return "#C68642";
  if (n.includes("tan") || n.includes("sand")) return "#D2B48C";
  if (n.includes("nude")) return "#E8C8B0";
  if (n.includes("beige")) return "#E8DCC8";
  if (n.includes("latte") || n.includes("mocha")) return "#B5836A";
  if (n.includes("chocolate") || n.includes("espresso")) return "#5D3A1A";
  if (n.includes("brown")) return "#795548";
  if (n.includes("dusty sage") || n.includes("sage green")) return "#9CAF88";
  if (n.includes("sage")) return "#9CAF88";
  if (n.includes("olive")) return "#7A8C5A";
  if (n.includes("forest") || n.includes("hunter")) return "#355E3B";
  if (n.includes("mint")) return "#9BE7C4";
  if (n.includes("emerald")) return "#3D9970";
  if (n.includes("green")) return "#6BAA75";
  if (n.includes("terracotta") || n.includes("clay")) return "#D4664A";
  if (n.includes("rust") || n.includes("burnt orange")) return "#A04030";
  if (n.includes("coral")) return "#FF8A65";
  if (n.includes("orange")) return "#FF7043";
  if (n.includes("burgundy") || n.includes("wine") || n.includes("maroon")) return "#7C1E34";
  if (n.includes("red")) return "#D32F2F";
  if (n.includes("dusty rose")) return "#D4A5A5";
  if (n.includes("blush")) return "#F2C4BF";
  if (n.includes("rose")) return "#E8A0A0";
  if (n.includes("mauve")) return "#C8A0B0";
  if (n.includes("pink")) return "#F06292";
  if (n.includes("lavender")) return "#C5B4E3";
  if (n.includes("lilac")) return "#C8A2C8";
  if (n.includes("purple") || n.includes("violet")) return "#8B5CF6";
  if (n.includes("plum")) return "#673AB7";
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
    ? `$${product.price.toFixed(0)}`
    : product.price_range !== "unknown" ? product.price_range : null;

  const handleClick = () => {
    trackProductClick({
      userToken,
      objectID: product.objectID,
      queryID:  product._queryID ?? "",
      position: product._position ?? 1,
    });
    fetch("/api/taste/click", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userToken,
        product: {
          objectID:    product.objectID,
          title:       product.title,
          brand:       product.brand,
          color:       product.color,
          category:    product.category,
          retailer:    product.retailer,
          price_range: product.price_range,
          image_url:   product.image_url,
        },
      }),
    }).catch(() => {});
  };

  return (
    <a
      href={product.product_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className="group block border border-border hover:border-border-mid transition-colors duration-300 bg-white/[0.02]"
    >
      <div className="aspect-[3/4] relative overflow-hidden bg-white/5">
        {product.image_url ? (
          <Image
            src={product.image_url}
            alt={product.title}
            fill
            className="object-cover group-hover:scale-[1.04] transition-transform duration-700"
            sizes="(max-width: 640px) 50vw, 25vw"
            unoptimized
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center font-display text-5xl font-light text-muted/20">▢</div>
        )}
        <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-background/60 to-transparent">
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
  category:  string;
  products:  AlgoliaProduct[];
  userToken: string;
}) {
  if (!products.length) return null;
  return (
    <div className="mb-12">
      <div className="flex items-baseline gap-4 mb-5 border-t border-border pt-6">
        <h3 className="font-display font-light text-2xl text-foreground">
          {CATEGORY_LABELS[category] ?? category}
        </h3>
        <span className="font-sans text-[9px] tracking-widest uppercase text-muted">{products.length} found</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {products.map((p) => (
          <ShopCard key={p.objectID} product={p} userToken={userToken} />
        ))}
      </div>
    </div>
  );
}

// ── Product card (edit results — has style notes) ─────────────────────────────

function ProductCard({
  product,
  position,
  userToken,
}: {
  product:   CuratedProduct;
  position:  number;
  userToken: string;
}) {
  const price =
    product.price != null
      ? `$${product.price.toFixed(0)}`
      : product.price_range !== "unknown"
      ? product.price_range
      : null;

  const handleClick = () => {
    trackProductClick({
      userToken,
      objectID: product.objectID,
      queryID:  product._queryID ?? "",
      position,
    });
    fetch("/api/taste/click", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userToken,
        product: {
          objectID:    product.objectID,
          title:       product.title,
          brand:       product.brand,
          color:       product.color,
          category:    product.category,
          retailer:    product.retailer,
          price_range: product.price_range,
          image_url:   product.image_url,
        },
      }),
    }).catch(() => {});
  };

  return (
    <a
      href={product.product_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className="group block border border-border hover:border-border-mid transition-colors duration-300 bg-white/[0.02]"
    >
      <div className="aspect-[3/4] relative overflow-hidden bg-white/5">
        {product.image_url ? (
          <Image
            src={product.image_url}
            alt={product.title}
            fill
            className="object-cover group-hover:scale-[1.04] transition-transform duration-700"
            sizes="(max-width: 640px) 50vw, 33vw"
            unoptimized
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center font-display text-5xl font-light text-muted/20">▢</div>
        )}
        {product.outfit_role && product.outfit_role !== "versatile staple" && (
          <div className="absolute top-3 right-3">
            <span className="font-sans text-[8px] tracking-widest uppercase bg-background/80 backdrop-blur-sm text-foreground/70 px-2 py-1">
              {product.outfit_role}
            </span>
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
          <p className="font-display font-light italic text-base text-muted-strong leading-relaxed line-clamp-2 mb-2">
            &ldquo;{product.style_note}&rdquo;
          </p>
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

function OutfitSection({
  label, role, products, startPosition, userToken,
}: {
  label:         string;
  role?:         string;
  products:      CuratedProduct[];
  startPosition: number;
  userToken:     string;
}) {
  if (!products.length) return null;
  return (
    <div className="mb-12">
      <div className="flex items-baseline gap-4 mb-6 border-t border-border pt-7">
        <h3 className="font-display font-light text-2xl text-foreground">{label}</h3>
        {role
          ? <span className="font-display font-light italic text-base text-muted-strong">{role}</span>
          : <span className="font-sans text-[9px] tracking-widest uppercase text-muted">{products.length} pieces</span>
        }
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {products.map((p, i) => (
          <ProductCard key={p.objectID} product={p} position={startPosition + i} userToken={userToken} />
        ))}
      </div>
    </div>
  );
}

// ── Style DNA card ────────────────────────────────────────────────────────────

function StyleDNACard({ dna }: { dna: StyleDNA }) {
  return (
    <div className="border border-border bg-white/[0.02]">
      <div className="px-7 pt-7 pb-6 border-b border-border">
        <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-6">Your Style Profile</p>
        <h2 className="font-display font-light text-4xl text-foreground capitalize leading-snug mb-1">{dna.primary_aesthetic}</h2>
        {dna.secondary_aesthetic && (
          <p className="font-display italic text-lg text-muted/70 capitalize">{dna.secondary_aesthetic}</p>
        )}
        <p className="font-sans text-base text-muted-strong leading-relaxed mt-5 max-w-2xl">{dna.summary}</p>
      </div>
      <div className="px-7 py-5 border-b border-border">
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
                <p className="font-sans text-sm text-foreground">
                  {ref.name}<span className="text-muted ml-2 font-light">— {ref.era}</span>
                </p>
                {ref.why && <p className="font-sans text-xs text-muted/70 mt-0.5 leading-relaxed">{ref.why}</p>}
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
              { label: "Casual",    pct: dna.occasion_mix.casual },
              { label: "Work",      pct: dna.occasion_mix.work },
              { label: "Weekend",   pct: dna.occasion_mix.weekend },
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

// ── Product scroll card (single item, full screen) ───────────────────────────

function ProductScrollCard({
  product,
  index,
  activeIdx,
  userToken,
}: {
  product:   AlgoliaProduct;
  index:     number;
  activeIdx: number;
  userToken: string;
}) {
  const price  = product.price != null ? `$${product.price.toFixed(0)}` : null;
  const isNear = Math.abs(index - activeIdx) <= 2;
  const [liked, setLiked] = useState(false);

  const handleProductClick = () => {
    // Track organic tap-through
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
    setLiked(nowLiked); // instant optimistic update — zero latency
    if (nowLiked) {
      // fire-and-forget — never blocks the UI
      trackProductClick({ userToken, objectID: product.objectID, queryID: product._queryID ?? "", position: index + 1 });
      fetch("/api/taste/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken, product: { objectID: product.objectID, title: product.title, brand: product.brand, color: product.color, category: product.category, retailer: product.retailer, price_range: product.price_range, image_url: product.image_url } }),
      }).catch(() => {});
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
          <Image
            src={product.image_url}
            alt={product.title}
            fill
            className="object-cover"
            unoptimized
            priority={isNear}
            sizes="100vw"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted/20 font-display text-6xl">▢</div>
        )}
      </div>

      {/* Top — retailer */}
      <div className="absolute top-14 left-4 z-10 pointer-events-none">
        <span className="font-sans text-[8px] tracking-widest uppercase text-white/40">{product.retailer}</span>
      </div>

      {/* Like button — right rail, above bottom info */}
      <button
        onClick={handleLike}
        className="absolute right-3 bottom-36 z-20 flex flex-col items-center gap-1 group"
        aria-label={liked ? "Unlike" : "Like"}
      >
        <span
          className="text-2xl leading-none transition-transform duration-100 group-active:scale-75"
          style={{
            transform: liked ? "scale(1.2)" : "scale(1)",
            transition: "transform 0.12s cubic-bezier(0.34,1.56,0.64,1)",
            filter: liked ? "drop-shadow(0 0 6px rgba(255,100,100,0.7))" : "none",
          }}
        >
          {liked ? "♥" : "♡"}
        </span>
        <span className="font-sans text-[7px] tracking-widest uppercase text-white/40">
          {liked ? "loved" : "like"}
        </span>
      </button>

      {/* Bottom overlay — product info + shop */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-4 py-6 bg-gradient-to-t from-background via-background/70 to-transparent">
        {product.brand && (
          <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1">{product.brand}</p>
        )}
        <p className="font-display font-light text-xl text-foreground leading-snug mb-1">{product.title}</p>
        {price && <p className="font-sans text-sm text-muted-strong mb-3">{price}</p>}
        <span className="inline-block font-sans text-[9px] tracking-widest uppercase text-foreground border-b border-foreground/30 pb-px">
          Shop →
        </span>
      </div>
    </a>
  );
}

// ── Product scroll view ───────────────────────────────────────────────────────

function ProductScrollView({
  products,
  onClose,
  userToken,
}: {
  products:  AlgoliaProduct[];
  onClose:   () => void;
  userToken: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, clientHeight } = containerRef.current;
    setActiveIdx(Math.round(scrollTop / clientHeight));
  }, []);

  // Preload next 3 images whenever active card changes
  useEffect(() => {
    products.slice(activeIdx + 1, activeIdx + 4).forEach((p) => {
      if (!p.image_url) return;
      const img = new window.Image();
      img.src = p.image_url;
    });
  }, [activeIdx, products]);

  return (
    /* Dimmed backdrop — click outside to close */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Centered portrait card */}
      <div
        className="relative flex flex-col overflow-hidden rounded-sm shadow-2xl"
        style={{ width: "min(88vw, 400px)", height: "min(88vh, 720px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mini header */}
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-background/90 to-transparent pointer-events-none">
          <button
            onClick={onClose}
            className="pointer-events-auto font-sans text-[9px] tracking-widest uppercase text-foreground/60 hover:text-foreground transition-colors"
          >
            ← Grid
          </button>
          <span className="font-sans text-[9px] tracking-widest uppercase text-foreground/30">
            {activeIdx + 1} / {products.length}
          </span>
        </div>

        {/* Scroll container — explicit h-full so children can use height:100% for snap */}
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="w-full h-full overflow-y-scroll"
          style={{ scrollSnapType: "y mandatory" }}
        >
          {products.map((p, i) => (
            <ProductScrollCard
              key={p.objectID}
              product={p}
              index={i}
              activeIdx={activeIdx}
              userToken={userToken}
            />
          ))}
        </div>

        {/* Scroll hint */}
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
  card,
  index,
  onLike,
  userToken,
}: {
  card:      OutfitCard;
  index:     number;
  onLike:    () => void;
  userToken: string;
}) {
  const cols = card.products.length === 1 ? 1 : card.products.length === 2 ? 2 : 3;

  return (
    <div
      className="relative flex flex-col bg-background"
      style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}
      data-card-index={index}
    >
      {/* Product images — equal columns */}
      <div className="flex-1 grid gap-px overflow-hidden" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {card.products.map((p) => (
          <a
            key={p.objectID}
            href={p.product_url || "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="relative overflow-hidden bg-white/5 group"
            onClick={() => trackProductClick({ userToken, objectID: p.objectID, queryID: p._queryID ?? "", position: 1 })}
          >
            {p.image_url ? (
              <Image
                src={p.image_url}
                alt={p.title}
                fill
                className="object-cover group-hover:scale-[1.03] transition-transform duration-700"
                unoptimized
                sizes="33vw"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-muted/20 font-display text-5xl">▢</div>
            )}
          </a>
        ))}
      </div>

      {/* Top overlay — outfit label + role */}
      <div className="absolute top-16 left-5 z-10 pointer-events-none">
        <p className="font-sans text-[8px] tracking-widest uppercase text-white/40 mb-0.5">{card.label}</p>
        {card.role && (
          <p className="font-display italic text-lg text-white/80 drop-shadow-sm">{card.role}</p>
        )}
      </div>

      {/* Right side — like button */}
      <button
        onClick={onLike}
        className="absolute right-4 bottom-40 z-10 flex flex-col items-center gap-1.5 group"
      >
        <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 ${
          card.liked
            ? "bg-red-500/90 scale-110"
            : "bg-background/60 backdrop-blur-sm border border-white/10 group-hover:scale-105"
        }`}>
          <span className={`text-xl leading-none transition-all duration-300 ${card.liked ? "text-white" : "text-white/60"}`}>
            {card.liked ? "♥" : "♡"}
          </span>
        </div>
        <span className="font-sans text-[8px] tracking-widest uppercase text-white/30">
          {card.liked ? "liked" : "like"}
        </span>
      </button>

      {/* Bottom overlay — product details */}
      <div className="absolute bottom-0 left-0 right-16 z-10 px-5 py-6 bg-gradient-to-t from-background/90 via-background/50 to-transparent">
        <div className="flex flex-col gap-2">
          {card.products.map((p) => (
            <a
              key={p.objectID}
              href={p.product_url || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="group/item"
            >
              <p className="font-sans text-xs text-foreground/90 line-clamp-1 group-hover/item:text-accent transition-colors">
                {p.title}
              </p>
              <p className="font-sans text-[10px] text-muted">
                {p.brand}{p.price != null ? ` · $${p.price.toFixed(0)}` : ""}
              </p>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Outfit scroll view (TikTok-style full-screen) ─────────────────────────────

function OutfitScrollView({
  cards,
  onLike,
  onNearEnd,
  isGeneratingMore,
  onClose,
  userToken,
}: {
  cards:             OutfitCard[];
  onLike:            (cardId: string) => void;
  onNearEnd:         () => void;
  isGeneratingMore:  boolean;
  onClose:           () => void;
  userToken:         string;
}) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const nearEndFired  = useRef(false);

  // Track active card via scroll position
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, clientHeight } = containerRef.current;
    const idx = Math.round(scrollTop / clientHeight);
    setActiveIdx(idx);
    // Fire nearEnd when 2 cards from the end
    if (!nearEndFired.current && idx >= cards.length - 2) {
      nearEndFired.current = true;
      onNearEnd();
    }
  }, [cards.length, onNearEnd]);

  // Reset nearEnd gate when new cards arrive
  useEffect(() => { nearEndFired.current = false; }, [cards.length]);

  // Preload next outfit images to eliminate scroll latency
  useEffect(() => {
    cards.slice(activeIdx + 1, activeIdx + 3).forEach((card) => {
      card.products.forEach((p) => {
        if (!p.image_url) return;
        const img = new window.Image();
        img.src = p.image_url;
      });
    });
  }, [activeIdx, cards]);

  return (
    /* Dimmed backdrop — click outside to close */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Centered portrait card */}
      <div
        className="relative flex flex-col overflow-hidden rounded-sm shadow-2xl"
        style={{ width: "min(88vw, 400px)", height: "min(88vh, 720px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mini header */}
        <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-background/90 to-transparent pointer-events-none">
          <button
            onClick={onClose}
            className="pointer-events-auto font-sans text-[9px] tracking-widest uppercase text-foreground/60 hover:text-foreground transition-colors"
          >
            ← Grid
          </button>
          <span className="font-sans text-[9px] tracking-widest uppercase text-foreground/30">
            {activeIdx + 1} / {cards.length}
          </span>
        </div>

        {/* Scroll container */}
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="w-full h-full overflow-y-scroll"
          style={{ scrollSnapType: "y mandatory" }}
        >
          {cards.map((card, i) => (
            <OutfitScrollCard
              key={card.id}
              card={card}
              index={i}
              onLike={() => onLike(card.id)}
              userToken={userToken}
            />
          ))}

          {/* Generating more indicator */}
          {isGeneratingMore && (
            <div
              className="flex items-center justify-center bg-background"
              style={{ height: "100%", minHeight: "100%", scrollSnapAlign: "start" }}
            >
              <p className="font-display italic text-xl text-muted">
                Musing<span className="inline-flex ml-0.5">
                  <span style={{ animation: "dotPulse 1.4s ease-in-out 0s infinite" }}>.</span>
                  <span style={{ animation: "dotPulse 1.4s ease-in-out 0.28s infinite" }}>.</span>
                  <span style={{ animation: "dotPulse 1.4s ease-in-out 0.56s infinite" }}>.</span>
                </span>
              </p>
            </div>
          )}
        </div>

        {/* Scroll hint on first card */}
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
  const [viewMode, setViewMode]             = useState<ViewMode>("grid");
  const [shopViewMode, setShopViewMode]     = useState<ViewMode>("grid");
  const [scrollCards, setScrollCards]       = useState<OutfitCard[]>([]);
  const [isGeneratingMore, setIsGeneratingMore] = useState(false);

  useEffect(() => {
    if (session?.user?.id) {
      setUserToken(session.user.id);
    } else {
      setUserToken(getUserToken());
    }
  }, [session]);

  useEffect(() => {
    const token = (session as { accessToken?: string })?.accessToken;
    if (!token) {
      if (session !== undefined) setBoardsLoading(false);
      return;
    }
    setBoardsLoading(true);
    fetch("/api/pinterest/boards", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => { if (data.boards?.length) setBoards(data.boards); })
      .catch(() => {})
      .finally(() => setBoardsLoading(false));
  }, [session]);

  useEffect(() => {
    if (!selectedBoard) { setPins([]); return; }
    const token = (session as { accessToken?: string })?.accessToken;
    if (!token) return;
    setPins([]);
    setPinsLoading(true);
    fetch(`/api/pinterest/pins?boardId=${selectedBoard.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => { if (data.pins?.length) setPins(data.pins); })
      .catch(() => {})
      .finally(() => setPinsLoading(false));
  }, [selectedBoard, session]);

  // Fire view events for shopping page products
  useEffect(() => {
    if (step === "shopping" && candidates) {
      const allProducts = CATEGORIES.flatMap((c) => candidates[c]);
      trackProductsViewed({ userToken, objectIDs: allProducts.map((p) => p.objectID) });
    }
  }, [step, candidates, userToken]);

  // Fire view events for edit products
  useEffect(() => {
    if (step === "results" && products.length > 0) {
      trackProductsViewed({ userToken, objectIDs: products.map((p) => p.objectID) });
    }
  }, [step, products, userToken]);

  // Step 1: Shop this board — analyze aesthetic + fetch product candidates
  const handleShop = useCallback(async () => {
    if (!selectedBoard) return;
    setStep("shopping_loading");
    setErrorMsg("");
    setShoppingStep(0);

    const t1 = setTimeout(() => setShoppingStep(1), 15000);

    try {
      const res = await fetch("/api/shop", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardId:      selectedBoard.id,
          boardName:    selectedBoard.name,
          pins:         pins.map((p) => ({ title: p.title, description: p.description })),
          pinImageUrls: pins.slice(0, 20).map((p) => p.imageUrl),
          userToken,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? "Shop failed");

      setAesthetic(data.aesthetic);
      setCandidates(data.candidates);
      setStep("shopping");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong.");
      setStep("error");
    } finally {
      clearTimeout(t1);
    }
  }, [selectedBoard, pins, userToken]);

  // Step 2: Build my edit — two-stage curation (also used for regenerate)
  const handleBuildEdit = useCallback(async (isAppend = false) => {
    if (!aesthetic || !candidates) return;
    setStep("edit_loading");
    setEditStep(0);

    const t1 = setTimeout(() => setEditStep(1), 8000);
    const t2 = setTimeout(() => setEditStep(2), 16000);

    try {
      const res = await fetch("/api/curate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aesthetic,
          candidates,
          boardId:   selectedBoard?.id,
          boardName: selectedBoard?.name,
          userToken,
        }),
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

      // Build scroll cards from the new outfits — append for regenerations
      const ts = Date.now();
      const newCards: OutfitCard[] = [];
      const a = ps.filter((p) => p.outfit_group === "outfit_a");
      const b = ps.filter((p) => p.outfit_group === "outfit_b");
      if (a.length) newCards.push({ id: `a-${ts}`, label: "Outfit A", role: data.outfit_a_role ?? "", products: a, liked: false });
      if (b.length) newCards.push({ id: `b-${ts}`, label: "Outfit B", role: data.outfit_b_role ?? "", products: b, liked: false });
      setScrollCards((prev) => isAppend ? [...prev, ...newCards] : newCards);

      setStep("results");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong.");
      setStep("error");
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
    }
  }, [aesthetic, candidates, selectedBoard, userToken]);

  // Generate more outfits for infinite scroll — appends cards, doesn't replace results
  const handleGenerateMore = useCallback(async () => {
    if (!aesthetic || !candidates || isGeneratingMore) return;
    setIsGeneratingMore(true);
    try {
      const res = await fetch("/api/curate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aesthetic, candidates, boardId: selectedBoard?.id, boardName: selectedBoard?.name, userToken }),
      });
      const data = await res.json();
      if (!res.ok) return; // silent fail — user just won't get more cards
      const ps: CuratedProduct[] = data.products ?? [];
      const ts = Date.now();
      const a = ps.filter((p) => p.outfit_group === "outfit_a");
      const b = ps.filter((p) => p.outfit_group === "outfit_b");
      const newCards: OutfitCard[] = [];
      if (a.length) newCards.push({ id: `a-${ts}`, label: "Outfit A", role: data.outfit_a_role ?? "", products: a, liked: false });
      if (b.length) newCards.push({ id: `b-${ts}`, label: "Outfit B", role: data.outfit_b_role ?? "", products: b, liked: false });
      setScrollCards((prev) => [...prev, ...newCards]);
    } finally {
      setIsGeneratingMore(false);
    }
  }, [aesthetic, candidates, selectedBoard, userToken, isGeneratingMore]);

  // Like a scroll card — records preference, influences future generations
  const handleLikeCard = useCallback((cardId: string) => {
    setScrollCards((prev) => prev.map((c) => {
      if (c.id !== cardId) return c;
      const nowLiked = !c.liked;
      // Record click signals for each product in the liked outfit
      if (nowLiked) {
        c.products.forEach((p) => {
          trackProductClick({ userToken, objectID: p.objectID, queryID: p._queryID ?? "", position: 1 });
          fetch("/api/taste/click", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userToken,
              product: { objectID: p.objectID, title: p.title, brand: p.brand, color: p.color, category: p.category, retailer: p.retailer, price_range: p.price_range, image_url: p.image_url },
            }),
          }).catch(() => {});
        });
      }
      return { ...c, liked: nowLiked };
    }));
  }, [userToken]);

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
    setViewMode("grid");
    setShopViewMode("grid");
    setScrollCards([]);
    setIsGeneratingMore(false);
  };

  const outfitA = products.filter((p) => p.outfit_group === "outfit_a");
  const outfitB = products.filter((p) => p.outfit_group === "outfit_b");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="px-8 py-5 border-b border-border sticky top-0 bg-background/90 backdrop-blur-md z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="font-display font-light tracking-[0.20em] text-base text-foreground hover:text-accent transition-colors duration-200">
            MUSE
          </Link>
          <div className="flex items-center gap-8">
            {step === "results" && (
              <button onClick={() => setStep("shopping")} className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors">
                ← My picks
              </button>
            )}
            {(step === "shopping" || step === "results") && (
              <button onClick={reset} className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors">
                ← New board
              </button>
            )}
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-8 py-16">

        {/* ── Board selection ── */}
        {step === "boards" && (
          <div className="fade-in-up">
            <div className="mb-14">
              <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-8">Your boards</p>
              <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-[1.05] mb-5">
                What are we<br />shopping for?
              </h1>
              <p className="font-sans text-base text-muted-strong max-w-sm leading-relaxed">
                Pick a board, then add photos for the best results. The more images, the more precise the edit.
              </p>
            </div>

            <div className="flex flex-col gap-px mb-2 border border-border">
              {boardsLoading ? (
                <div className="px-5 py-8 text-center">
                  <p className="font-sans text-xs text-muted">Loading your boards…</p>
                </div>
              ) : boards.length === 0 ? (
                <div className="px-5 py-8 text-center">
                  <p className="font-sans text-xs text-muted">No boards found. Make sure your Pinterest account has public boards.</p>
                </div>
              ) : (
                boards.map((board) => (
                  <BoardCard
                    key={board.id}
                    board={board}
                    selected={selectedBoard?.id === board.id}
                    onClick={() => setSelectedBoard(board)}
                  />
                ))
              )}
            </div>

            {selectedBoard && (
              <div className="border border-t-0 border-border px-5 pb-6">
                <PinGrid pins={pins} loading={pinsLoading} />
              </div>
            )}

            <div className="mt-8">
              <button
                onClick={handleShop}
                disabled={!selectedBoard || pinsLoading}
                className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200 disabled:opacity-25 disabled:cursor-not-allowed"
              >
                {!selectedBoard ? "Select a board" : pinsLoading ? "Loading pins…" : "Shop this board →"}
              </button>
              {selectedBoard && !pinsLoading && pins.length === 0 && (
                <p className="font-sans text-[11px] text-muted mt-3">
                  No pins found — we&apos;ll infer your aesthetic from the board name.
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── Shopping loading ── */}
        {step === "shopping_loading" && (
          <LoadingScreen
            title="Finding your picks."
            steps={SHOPPING_STEPS}
            currentStep={shoppingStep}
          />
        )}

        {/* ── Shopping results ── */}
        {step === "shopping" && aesthetic && candidates && (() => {
          const terms = [
            ...(aesthetic.style_keywords ?? []),
            ...(aesthetic.color_palette ?? []).map((c) => c.toLowerCase().split(" ").pop() ?? c),
            aesthetic.primary_aesthetic?.toLowerCase() ?? "",
          ].map((t) => t.toLowerCase());

          const scored = CATEGORIES.flatMap((cat) => candidates[cat]).map((p) => {
            const haystack = [
              ...(p.aesthetic_tags ?? []),
              (p.title ?? "").toLowerCase(),
              (p.description ?? "").toLowerCase(),
            ].join(" ");
            const score = terms.filter((t) => t.length > 2 && haystack.includes(t)).length;
            return { product: p, score };
          });
          scored.sort((a, b) => b.score - a.score);
          const sortedProducts = scored.map(({ product }) => product);

          return (
            <>
              {/* TikTok scroll overlay for shopping page */}
              {shopViewMode === "scroll" && (
                <ProductScrollView
                  products={sortedProducts}
                  onClose={() => setShopViewMode("grid")}
                  userToken={userToken}
                />
              )}

              <div className="fade-in-up">
                <div className="flex items-start justify-between mb-8 gap-6">
                  <div>
                    <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-5">
                      {selectedBoard?.name} — {sortedProducts.length} picks
                    </p>
                    <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight capitalize mb-1">
                      {aesthetic.primary_aesthetic}
                    </h1>
                    {aesthetic.mood && (
                      <p className="font-display italic text-xl text-muted mt-1.5 capitalize">{aesthetic.mood}</p>
                    )}
                    {aesthetic.summary && (
                      <p className="font-sans text-base text-muted-strong leading-relaxed mt-4 max-w-2xl">{aesthetic.summary}</p>
                    )}
                  </div>
                  {/* Grid / Scroll toggle */}
                  <div className="flex border border-border overflow-hidden flex-shrink-0 mt-1">
                    <button
                      onClick={() => setShopViewMode("grid")}
                      className={`px-4 py-2 font-sans text-[9px] tracking-widest uppercase transition-colors duration-150 ${
                        shopViewMode === "grid" ? "bg-foreground text-background" : "text-muted hover:text-foreground"
                      }`}
                    >
                      Grid
                    </button>
                    <button
                      onClick={() => setShopViewMode("scroll")}
                      className={`px-4 py-2 font-sans text-[9px] tracking-widest uppercase transition-colors duration-150 border-l border-border ${
                        shopViewMode === "scroll" ? "bg-foreground text-background" : "text-muted hover:text-foreground"
                      }`}
                    >
                      Scroll
                    </button>
                  </div>
                </div>

                {/* Palette */}
                <div className="flex flex-wrap gap-4 mb-10">
                  {(aesthetic.color_palette ?? []).map((color) => (
                    <div key={color} className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full ring-1 ring-white/10 flex-shrink-0" style={{ backgroundColor: colorToCSS(color) }} />
                      <span className="font-sans text-xs text-muted-strong capitalize">{color}</span>
                    </div>
                  ))}
                </div>

                {/* Build my edit CTA */}
                <div className="mb-14 flex items-center gap-6">
                  <button
                    onClick={() => handleBuildEdit()}
                    className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200"
                  >
                    Build my edit →
                  </button>
                  <p className="font-sans text-[11px] text-muted">
                    Claude will shortlist and style the best finds into a curated edit.
                  </p>
                </div>

                {/* All products — ranked by aesthetic relevance */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-14">
                  {sortedProducts.map((product) => (
                    <ShopCard key={product.objectID} product={product} userToken={userToken} />
                  ))}
                </div>

                <div className="border-t border-border pt-7 flex items-center justify-between mt-4">
                  <p className="font-sans text-[11px] text-muted/50 max-w-sm leading-relaxed">
                    MUSE earns a small affiliate commission if you purchase, at no extra cost to you.
                  </p>
                  <button
                    onClick={() => handleBuildEdit()}
                    className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200"
                  >
                    Build my edit →
                  </button>
                </div>
              </div>
            </>
          );
        })()}

        {/* ── Edit loading ── */}
        {step === "edit_loading" && (
          <LoadingScreen
            title="Building your edit."
            steps={EDIT_STEPS}
            currentStep={editStep}
          />
        )}

        {/* ── Error ── */}
        {step === "error" && (
          <div className="fade-in flex flex-col items-center justify-center py-40 text-center">
            <h2 className="font-display font-light text-3xl text-foreground mb-3">Something went wrong.</h2>
            <p className="font-sans text-base text-muted-strong mb-12 max-w-sm">{errorMsg}</p>
            <button onClick={reset} className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors">
              Try again
            </button>
          </div>
        )}

        {/* ── Edit results ── */}
        {step === "results" && aesthetic && (
          <>
          {/* TikTok scroll view — full-screen overlay */}
          {viewMode === "scroll" && (
            <OutfitScrollView
              cards={scrollCards}
              onLike={handleLikeCard}
              onNearEnd={handleGenerateMore}
              isGeneratingMore={isGeneratingMore}
              onClose={() => setViewMode("grid")}
              userToken={userToken}
            />
          )}

          <div className="fade-in-up">
            <div className="flex items-start justify-between mb-12 gap-6">
              <div>
                <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-5">Personal edit</p>
                <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight">{selectedBoard?.name}</h1>
                {aesthetic.mood && <p className="font-display italic text-xl text-muted mt-1.5 capitalize">{aesthetic.mood}</p>}
              </div>
              <div className="flex items-center gap-3 flex-shrink-0 mt-1">
                {/* View toggle */}
                <div className="flex border border-border overflow-hidden">
                  <button
                    onClick={() => setViewMode("grid")}
                    className={`px-4 py-2 font-sans text-[9px] tracking-widest uppercase transition-colors duration-150 ${
                      viewMode === "grid" ? "bg-foreground text-background" : "text-muted hover:text-foreground"
                    }`}
                  >
                    Grid
                  </button>
                  <button
                    onClick={() => setViewMode("scroll")}
                    className={`px-4 py-2 font-sans text-[9px] tracking-widest uppercase transition-colors duration-150 border-l border-border ${
                      viewMode === "scroll" ? "bg-foreground text-background" : "text-muted hover:text-foreground"
                    }`}
                  >
                    Scroll
                  </button>
                </div>
                <button
                  onClick={() => handleBuildEdit()}
                  className="px-6 py-2.5 border border-border hover:border-foreground/60 text-foreground font-sans text-[10px] tracking-widest uppercase transition-colors duration-200"
                >
                  Regenerate
                </button>
              </div>
            </div>

            <div className="mb-14"><StyleDNACard dna={aesthetic} /></div>

            {(editorialIntro || editRationale) && (
              <div className="mb-10 max-w-2xl">
                {editorialIntro && <p className="font-display font-light italic text-xl text-muted-strong leading-relaxed mb-3">{editorialIntro}</p>}
                {editRationale && <p className="font-sans text-xs text-muted tracking-wide">{editRationale}</p>}
              </div>
            )}

            {outfitArc && (
              <div className="mb-8 flex items-center gap-4">
                <span className="font-sans text-[9px] tracking-widest uppercase text-muted">Edit arc</span>
                <span className="font-display font-light italic text-base text-muted-strong">{outfitArc}</span>
              </div>
            )}

            <OutfitSection label="Outfit A" role={outfitARole} products={outfitA} startPosition={1}                    userToken={userToken} />
            <OutfitSection label="Outfit B" role={outfitBRole} products={outfitB} startPosition={outfitA.length + 1} userToken={userToken} />

            {outfitA.length === 0 && outfitB.length === 0 && products.length > 0 && (
              <div>
                <div className="flex items-baseline justify-between mb-6 border-t border-border pt-7">
                  <h2 className="font-display font-light text-2xl text-foreground">Your curated edit</h2>
                  <p className="font-sans text-[9px] tracking-widest uppercase text-muted">{products.length} pieces</p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-14">
                  {products.map((p, i) => (
                    <ProductCard key={p.objectID} product={p} position={i + 1} userToken={userToken} />
                  ))}
                </div>
              </div>
            )}

            <div className="border-t border-border pt-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
              <p className="font-sans text-[11px] text-muted/50 max-w-sm leading-relaxed">
                MUSE earns a small affiliate commission if you purchase, at no extra cost to you.
              </p>
              <div className="flex items-center gap-6">
                <button onClick={() => setStep("shopping")} className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors whitespace-nowrap">
                  ← My picks
                </button>
                <button onClick={reset} className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors whitespace-nowrap">
                  ← New board
                </button>
              </div>
            </div>
          </div>
          </>
        )}
      </main>
    </div>
  );
}
