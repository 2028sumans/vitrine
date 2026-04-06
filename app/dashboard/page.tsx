"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type { StyleDNA, CuratedProduct } from "@/lib/ai";

// ── Mock boards ───────────────────────────────────────────────────────────────

const MOCK_BOARDS = [
  { id: "1", name: "Dream Home",      pin_count: 142 },
  { id: "2", name: "Fashion Inspo",   pin_count: 89  },
  { id: "3", name: "Travel Wishlist", pin_count: 64  },
  { id: "4", name: "Cozy Kitchen",    pin_count: 201 },
  { id: "5", name: "Beauty & Skin",   pin_count: 77  },
  { id: "6", name: "Outdoor Living",  pin_count: 53  },
];

type Board = (typeof MOCK_BOARDS)[number];
type Step = "boards" | "analyzing" | "results" | "error";

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
        <div>
          <p className="font-display font-light text-lg text-foreground leading-snug">
            {board.name}
          </p>
          <p className="font-sans text-[11px] text-muted mt-0.5 tracking-wide">
            {board.pin_count} pins
          </p>
        </div>
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

// ── Product card ──────────────────────────────────────────────────────────────

function ProductCard({ product }: { product: CuratedProduct }) {
  const price =
    product.price != null
      ? `$${product.price.toFixed(0)}`
      : product.price_range !== "unknown"
      ? product.price_range
      : null;

  return (
    <a
      href={product.product_url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="group block border border-border hover:border-border-mid transition-colors duration-300 bg-white/[0.02]"
    >
      {/* Image */}
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

        {/* Outfit role */}
        {product.outfit_role && product.outfit_role !== "versatile staple" && (
          <div className="absolute top-3 right-3">
            <span className="font-sans text-[8px] tracking-widest uppercase bg-background/80 backdrop-blur-sm text-foreground/70 px-2 py-1">
              {product.outfit_role}
            </span>
          </div>
        )}

        {/* Retailer */}
        <div className="absolute bottom-0 left-0 right-0 px-3 py-2.5 bg-gradient-to-t from-background/60 to-transparent">
          <p className="font-sans text-[9px] tracking-widest uppercase text-foreground/60">
            {product.retailer}
          </p>
        </div>
      </div>

      {/* Info */}
      <div className="p-4 border-t border-border">
        {product.brand && product.brand.toLowerCase() !== product.retailer.toLowerCase() && (
          <p className="font-sans text-[9px] tracking-widest uppercase text-accent mb-1.5">
            {product.brand}
          </p>
        )}
        <p className="font-sans text-sm text-foreground leading-snug line-clamp-2 mb-2.5">
          {product.title}
        </p>

        {/* Stylist note */}
        {product.style_note && (
          <p className="font-display font-light italic text-base text-muted-strong leading-relaxed line-clamp-2 mb-2">
            &ldquo;{product.style_note}&rdquo;
          </p>
        )}

        {/* How to wear */}
        {product.how_to_wear && (
          <p className="font-sans text-[11px] text-muted leading-relaxed mb-3">
            <span className="text-accent font-medium">Wear it: </span>
            {product.how_to_wear}
          </p>
        )}

        <div className="flex items-center justify-between pt-3 border-t border-border">
          {price ? (
            <span className="font-sans text-xs font-medium text-foreground">{price}</span>
          ) : <span />}
          <span className="font-sans text-[9px] tracking-widest uppercase text-muted group-hover:text-accent transition-colors duration-200">
            Shop →
          </span>
        </div>
      </div>
    </a>
  );
}

// ── Outfit section ────────────────────────────────────────────────────────────

function OutfitSection({ label, products }: { label: string; products: CuratedProduct[] }) {
  if (products.length === 0) return null;
  return (
    <div className="mb-12">
      <div className="flex items-baseline gap-4 mb-6 border-t border-border pt-7">
        <h3 className="font-display font-light text-2xl text-foreground">{label}</h3>
        <span className="font-sans text-[9px] tracking-widest uppercase text-muted">
          {products.length} pieces
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {products.map((p) => (
          <ProductCard key={p.objectID} product={p} />
        ))}
      </div>
    </div>
  );
}

// ── Style DNA card ────────────────────────────────────────────────────────────

function StyleDNACard({ dna }: { dna: StyleDNA }) {
  return (
    <div className="border border-border bg-white/[0.02]">

      {/* Header */}
      <div className="px-7 pt-7 pb-6 border-b border-border">
        <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-6">
          Your Style Profile
        </p>
        <h2 className="font-display font-light text-4xl text-foreground capitalize leading-snug mb-1">
          {dna.primary_aesthetic}
        </h2>
        {dna.secondary_aesthetic && (
          <p className="font-display italic text-lg text-muted/70 capitalize">
            {dna.secondary_aesthetic}
          </p>
        )}
        <p className="font-sans text-base text-muted-strong leading-relaxed mt-5 max-w-2xl">
          {dna.summary}
        </p>
      </div>

      {/* Palette */}
      <div className="px-7 py-5 border-b border-border">
        <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">
          Your palette
        </p>
        <div className="flex flex-wrap gap-5">
          {(dna.color_palette ?? []).map((color) => (
            <div key={color} className="flex items-center gap-2.5">
              <div
                className="w-3.5 h-3.5 rounded-full flex-shrink-0 ring-1 ring-white/10"
                style={{ backgroundColor: colorToCSS(color) }}
              />
              <span className="font-sans text-sm text-muted-strong capitalize">{color}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Style references */}
      {(dna.style_references ?? []).length > 0 && (
        <div className="px-7 py-5 border-b border-border">
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">
            Inspired by
          </p>
          <div className="flex flex-col gap-4">
            {dna.style_references.map((ref) => (
              <div key={ref.name}>
                <p className="font-sans text-sm text-foreground">
                  {ref.name}
                  <span className="text-muted ml-2 font-light">— {ref.era}</span>
                </p>
                {ref.why && (
                  <p className="font-sans text-xs text-muted/70 mt-0.5 leading-relaxed">{ref.why}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reaches for / Avoids */}
      <div className="px-7 py-5 border-b border-border grid grid-cols-2 gap-8">
        <div>
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">
            Reaches for
          </p>
          <ul className="flex flex-col gap-2">
            {(dna.key_pieces ?? []).slice(0, 5).map((p) => (
              <li key={p} className="font-sans text-sm text-muted-strong flex items-center gap-2.5">
                <span className="w-3 h-px bg-accent/60 flex-shrink-0" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">
            Avoids
          </p>
          <ul className="flex flex-col gap-2">
            {(dna.avoids ?? []).slice(0, 4).map((a) => (
              <li key={a} className="font-sans text-sm text-muted flex items-center gap-2.5">
                <span className="w-3 h-px bg-muted/30 flex-shrink-0" />
                {a}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Occasion mix */}
      {dna.occasion_mix && (
        <div className="px-7 py-5">
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">
            Where you wear it
          </p>
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
            ]
              .filter(({ pct }) => pct > 0)
              .map(({ label, pct }) => (
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

// ── Page ──────────────────────────────────────────────────────────────────────

const ANALYZING_STEPS = [
  { label: "Decoding aesthetic",       sub: "Colors, silhouettes & cultural references" },
  { label: "Searching by category",    sub: "Dresses, tops, layers, shoes & bags" },
  { label: "Building two outfits",     sub: "Pieces that actually work together" },
  { label: "Writing your edit",        sub: "Styling notes & editorial intro" },
];

export default function DashboardPage() {
  const [step, setStep]                   = useState<Step>("boards");
  const [selectedBoard, setSelectedBoard] = useState<Board | null>(null);
  const [aesthetic, setAesthetic]         = useState<StyleDNA | null>(null);
  const [products, setProducts]           = useState<CuratedProduct[]>([]);
  const [editorialIntro, setEditorialIntro] = useState("");
  const [editRationale, setEditRationale]   = useState("");
  const [analyzeStep, setAnalyzeStep]     = useState(0);
  const [errorMsg, setErrorMsg]           = useState("");

  const handleAnalyze = async () => {
    if (!selectedBoard) return;
    setStep("analyzing");
    setErrorMsg("");
    setAnalyzeStep(0);

    const t1 = setTimeout(() => setAnalyzeStep(1), 5000);
    const t2 = setTimeout(() => setAnalyzeStep(2), 11000);
    const t3 = setTimeout(() => setAnalyzeStep(3), 17000);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId: selectedBoard.id, boardName: selectedBoard.name, pins: [] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? "Analysis failed");

      setAesthetic(data.aesthetic);
      setProducts(data.products);
      setEditorialIntro(data.editorial_intro ?? "");
      setEditRationale(data.edit_rationale ?? "");
      setStep("results");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong.");
      setStep("error");
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    }
  };

  const reset = () => {
    setStep("boards");
    setSelectedBoard(null);
    setAesthetic(null);
    setProducts([]);
    setEditorialIntro("");
    setEditRationale("");
    setErrorMsg("");
    setAnalyzeStep(0);
  };

  const outfitA = products.filter((p) => p.outfit_group === "outfit_a");
  const outfitB = products.filter((p) => p.outfit_group === "outfit_b");

  return (
    <div className="min-h-screen bg-background text-foreground">

      {/* Nav */}
      <header className="px-8 py-5 border-b border-border sticky top-0 bg-background/90 backdrop-blur-md z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="font-display font-light tracking-[0.20em] text-base text-foreground hover:text-accent transition-colors duration-200">
            VITRINE
          </Link>
          <div className="flex items-center gap-8">
            {step === "results" && (
              <button onClick={reset} className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors">
                ← New board
              </button>
            )}
            <div className="w-7 h-7 border border-border flex items-center justify-center font-sans text-[10px] text-muted">
              S
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-8 py-16">

        {/* ── Board selection ── */}
        {step === "boards" && (
          <div className="fade-in-up">
            <div className="mb-14">
              <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-8">
                Your Pinterest boards
              </p>
              <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-[1.05] mb-5">
                Which board should<br />we shop for you?
              </h1>
              <p className="font-sans text-base text-muted-strong max-w-sm leading-relaxed">
                Select a board and we&apos;ll decode its aesthetic, then curate
                two complete outfits that match your taste.
              </p>
            </div>

            <div className="flex flex-col gap-px mb-12 border border-border">
              {MOCK_BOARDS.map((board) => (
                <BoardCard
                  key={board.id}
                  board={board}
                  selected={selectedBoard?.id === board.id}
                  onClick={() => setSelectedBoard(board)}
                />
              ))}
            </div>

            <button
              onClick={handleAnalyze}
              disabled={!selectedBoard}
              className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200 disabled:opacity-25 disabled:cursor-not-allowed"
            >
              {selectedBoard ? "Build my edit →" : "Select a board"}
            </button>
          </div>
        )}

        {/* ── Analyzing ── */}
        {step === "analyzing" && (
          <div className="fade-in flex flex-col items-center justify-center py-40 text-center">
            <div className="relative w-10 h-10 mb-16">
              <div className="absolute inset-0 rounded-full border border-border" />
              <div className="absolute inset-0 rounded-full border border-transparent border-t-foreground/60 animate-spin" style={{ animationDuration: "1.4s" }} />
            </div>

            <h2 className="font-display font-light text-4xl text-foreground mb-2">
              Building your edit.
            </h2>
            <p className="font-sans text-base text-muted-strong mb-16">
              About 20 seconds — being thorough.
            </p>

            <div className="flex flex-col gap-6 text-left max-w-xs w-full">
              {ANALYZING_STEPS.map(({ label, sub }, i) => (
                <div key={i} className="flex items-start gap-4">
                  <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 transition-all duration-700 ${
                    i < analyzeStep
                      ? "bg-accent"
                      : i === analyzeStep
                      ? "bg-foreground/80 shadow-[0_0_6px_rgba(240,232,216,0.4)]"
                      : "bg-foreground/15"
                  }`} />
                  <div>
                    <p className={`font-sans text-xs transition-colors duration-500 ${i <= analyzeStep ? "text-foreground" : "text-muted/50"}`}>
                      {label}
                    </p>
                    <p className="font-sans text-[11px] text-muted/50 mt-0.5">{sub}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
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

        {/* ── Results ── */}
        {step === "results" && aesthetic && (
          <div className="fade-in-up">

            {/* Header */}
            <div className="mb-12">
              <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-5">
                Personal edit
              </p>
              <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight">
                {selectedBoard?.name}
              </h1>
              {aesthetic.mood && (
                <p className="font-display italic text-xl text-muted mt-1.5 capitalize">
                  {aesthetic.mood}
                </p>
              )}
            </div>

            {/* Style DNA */}
            <div className="mb-14">
              <StyleDNACard dna={aesthetic} />
            </div>

            {/* Editorial intro + rationale */}
            {(editorialIntro || editRationale) && (
              <div className="mb-10 max-w-2xl">
                {editorialIntro && (
                  <p className="font-display font-light italic text-xl text-muted-strong leading-relaxed mb-3">
                    {editorialIntro}
                  </p>
                )}
                {editRationale && (
                  <p className="font-sans text-xs text-muted tracking-wide">
                    {editRationale}
                  </p>
                )}
              </div>
            )}

            {/* Outfit A */}
            <OutfitSection label="Outfit A" products={outfitA} />

            {/* Outfit B */}
            <OutfitSection label="Outfit B" products={outfitB} />

            {/* Flat fallback if outfit grouping didn't work */}
            {outfitA.length === 0 && outfitB.length === 0 && products.length > 0 && (
              <div>
                <div className="flex items-baseline justify-between mb-6 border-t border-border pt-7">
                  <h2 className="font-display font-light text-2xl text-foreground">Your curated edit</h2>
                  <p className="font-sans text-[9px] tracking-widest uppercase text-muted">{products.length} pieces</p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-14">
                  {products.map((p) => <ProductCard key={p.objectID} product={p} />)}
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="border-t border-border pt-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
              <p className="font-sans text-[11px] text-muted/50 max-w-sm leading-relaxed">
                VITRINE earns a small affiliate commission if you purchase, at no extra cost to you.
              </p>
              <button onClick={reset} className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors whitespace-nowrap">
                ← Try another board
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
