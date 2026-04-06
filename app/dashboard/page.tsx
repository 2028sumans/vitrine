"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type { StyleDNA, CuratedProduct } from "@/lib/ai";

// ── Mock boards ───────────────────────────────────────────────────────────────

const MOCK_BOARDS = [
  { id: "1", name: "Dream Home", pin_count: 142, gradient: "from-[#EAE0D5] to-[#D4C4B0]" },
  { id: "2", name: "Fashion Inspo", pin_count: 89, gradient: "from-[#DDD5E8] to-[#C4B5D8]" },
  { id: "3", name: "Travel Wishlist", pin_count: 64, gradient: "from-[#D0DDE8] to-[#B0C8D8]" },
  { id: "4", name: "Cozy Kitchen", pin_count: 201, gradient: "from-[#EAD8C0] to-[#D4A87C]" },
  { id: "5", name: "Beauty & Skin", pin_count: 77, gradient: "from-[#EDD8D8] to-[#E0B0B0]" },
  { id: "6", name: "Outdoor Living", pin_count: 53, gradient: "from-[#D0E0D0] to-[#A0C4A0]" },
];

type Board = (typeof MOCK_BOARDS)[number];
type Step = "boards" | "analyzing" | "results" | "error";

// ── Color name → CSS ──────────────────────────────────────────────────────────

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
  return "#DDD5C8";
}

// ── Board card ────────────────────────────────────────────────────────────────

function BoardCard({ board, selected, onClick }: {
  board: Board;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`group w-full text-left transition-all duration-200 ${
        selected ? "ring-1 ring-foreground" : "hover:ring-1 hover:ring-border"
      }`}
    >
      <div className={`w-full aspect-[4/3] bg-gradient-to-br ${board.gradient}`} />
      <div className="bg-white px-4 py-3 border border-t-0 border-border">
        <div className="flex items-center justify-between">
          <p className="font-sans text-xs font-medium text-foreground truncate">{board.name}</p>
          {selected && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="flex-shrink-0">
              <path d="M2 6l3 3 5-5" stroke="#111111" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
        <p className="font-sans text-[10px] text-muted mt-0.5">{board.pin_count} pins</p>
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
      className="group block bg-white border border-border hover:border-foreground transition-colors duration-200"
    >
      {/* Image */}
      <div className="aspect-[3/4] bg-[#F0EBE3] relative overflow-hidden">
        {product.image_url ? (
          <Image
            src={product.image_url}
            alt={product.title}
            fill
            className="object-cover group-hover:scale-[1.03] transition-transform duration-500"
            sizes="(max-width: 640px) 50vw, 33vw"
            unoptimized
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-3xl text-muted/30">
            ▢
          </div>
        )}
        {/* Retailer */}
        <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/40 to-transparent">
          <span className="font-sans text-[9px] tracking-widest uppercase text-white/80">
            {product.retailer}
          </span>
        </div>
        {/* Outfit role */}
        {product.outfit_role && product.outfit_role !== "versatile staple" && (
          <div className="absolute top-2.5 right-2.5">
            <span className="font-sans text-[8px] tracking-widest uppercase bg-white/90 text-foreground px-2 py-0.5">
              {product.outfit_role}
            </span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-4 border-t border-border">
        {product.brand && product.brand.toLowerCase() !== product.retailer.toLowerCase() && (
          <p className="font-sans text-[9px] font-medium tracking-widest uppercase text-muted mb-1">
            {product.brand}
          </p>
        )}
        <p className="font-sans text-xs text-foreground leading-snug line-clamp-2 mb-2">
          {product.title}
        </p>
        {product.style_note && (
          <p className="font-display text-sm italic text-muted leading-relaxed line-clamp-2 mb-3">
            &ldquo;{product.style_note}&rdquo;
          </p>
        )}
        <div className="flex items-center justify-between pt-2.5 border-t border-border">
          {price ? (
            <span className="font-sans text-xs font-medium text-foreground">{price}</span>
          ) : (
            <span />
          )}
          <span className="font-sans text-[9px] tracking-widest uppercase text-accent group-hover:text-foreground transition-colors">
            Shop →
          </span>
        </div>
      </div>
    </a>
  );
}

// ── Style DNA card ────────────────────────────────────────────────────────────

function StyleDNACard({ dna }: { dna: StyleDNA }) {
  return (
    <div className="border border-border bg-white">
      {/* Header */}
      <div className="px-7 pt-7 pb-6 border-b border-border">
        <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-5">
          Your Style Profile
        </p>
        <h2 className="font-display font-light text-3xl capitalize leading-snug text-foreground mb-1">
          {dna.primary_aesthetic}
        </h2>
        {dna.secondary_aesthetic && (
          <p className="font-display italic text-base text-muted capitalize">
            {dna.secondary_aesthetic}
          </p>
        )}
        <p className="font-sans text-sm text-muted leading-relaxed mt-4 max-w-xl">
          {dna.summary}
        </p>
      </div>

      {/* Palette */}
      <div className="px-7 py-5 border-b border-border">
        <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">
          Your palette
        </p>
        <div className="flex flex-wrap gap-4">
          {(dna.color_palette ?? []).map((color) => (
            <div key={color} className="flex items-center gap-2">
              <div
                className="w-4 h-4 rounded-full border border-border ring-1 ring-white flex-shrink-0"
                style={{ backgroundColor: colorToCSS(color) }}
              />
              <span className="font-sans text-xs text-foreground capitalize">{color}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Reaches for / Avoids */}
      <div className="px-7 py-5 border-b border-border grid grid-cols-2 gap-8">
        <div>
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-3">
            Reaches for
          </p>
          <ul className="flex flex-col gap-1.5">
            {(dna.key_pieces ?? []).slice(0, 5).map((p) => (
              <li key={p} className="font-sans text-xs text-foreground flex items-center gap-2">
                <span className="w-1 h-px bg-accent flex-shrink-0 inline-block" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-3">
            Avoids
          </p>
          <ul className="flex flex-col gap-1.5">
            {(dna.avoids ?? []).slice(0, 4).map((a) => (
              <li key={a} className="font-sans text-xs text-muted flex items-center gap-2">
                <span className="w-1 h-px bg-muted/40 flex-shrink-0 inline-block" />
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
          {/* Segmented bar */}
          <div className="flex h-1 w-full overflow-hidden gap-px">
            {dna.occasion_mix.casual > 0 && (
              <div style={{ width: `${dna.occasion_mix.casual}%` }} className="bg-foreground" />
            )}
            {dna.occasion_mix.work > 0 && (
              <div style={{ width: `${dna.occasion_mix.work}%` }} className="bg-foreground/50" />
            )}
            {dna.occasion_mix.weekend > 0 && (
              <div style={{ width: `${dna.occasion_mix.weekend}%` }} className="bg-foreground/30" />
            )}
            {dna.occasion_mix.going_out > 0 && (
              <div style={{ width: `${dna.occasion_mix.going_out}%` }} className="bg-foreground/15" />
            )}
          </div>
          <div className="flex gap-6 mt-3 flex-wrap">
            {[
              { label: "Casual", pct: dna.occasion_mix.casual },
              { label: "Work", pct: dna.occasion_mix.work },
              { label: "Weekend", pct: dna.occasion_mix.weekend },
              { label: "Going out", pct: dna.occasion_mix.going_out },
            ]
              .filter(({ pct }) => pct > 0)
              .map(({ label, pct }) => (
                <div key={label} className="font-sans text-[11px] text-muted">
                  <span className="font-medium text-foreground">{pct}%</span>{" "}{label}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [step, setStep] = useState<Step>("boards");
  const [selectedBoard, setSelectedBoard] = useState<Board | null>(null);
  const [aesthetic, setAesthetic] = useState<StyleDNA | null>(null);
  const [products, setProducts] = useState<CuratedProduct[]>([]);
  const [analyzeStep, setAnalyzeStep] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  const handleAnalyze = async () => {
    if (!selectedBoard) return;
    setStep("analyzing");
    setErrorMsg("");
    setAnalyzeStep(0);

    // Advance visible step every ~5s to feel live
    const stepTimer1 = setTimeout(() => setAnalyzeStep(1), 5000);
    const stepTimer2 = setTimeout(() => setAnalyzeStep(2), 11000);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardId: selectedBoard.id,
          boardName: selectedBoard.name,
          pins: [],
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? "Analysis failed");

      setAesthetic(data.aesthetic);
      setProducts(data.products);
      setStep("results");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong.");
      setStep("error");
    } finally {
      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);
    }
  };

  const reset = () => {
    setStep("boards");
    setSelectedBoard(null);
    setAesthetic(null);
    setProducts([]);
    setErrorMsg("");
    setAnalyzeStep(0);
  };

  const analyzingSteps = [
    { label: "Decoding aesthetic", sub: "Reading colors, silhouettes & mood" },
    { label: "Searching 40,000+ products", sub: "ASOS, Nordstrom, Revolve & more" },
    { label: "Curating your edit", sub: "Selecting pieces that truly fit" },
  ];

  return (
    <div className="min-h-screen bg-background">

      {/* Nav */}
      <header className="px-8 py-5 border-b border-border sticky top-0 bg-background/90 backdrop-blur-md z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="font-display font-light tracking-[0.18em] text-base text-foreground">
            VITRINE
          </Link>
          <div className="flex items-center gap-6">
            {step === "results" && (
              <button
                onClick={reset}
                className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors"
              >
                ← New board
              </button>
            )}
            <div className="w-7 h-7 border border-border bg-accent-subtle flex items-center justify-center font-sans text-[10px] font-medium text-accent tracking-wider">
              S
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-8 py-16">

        {/* ── Board selection ── */}
        {step === "boards" && (
          <div className="fade-in-up">
            <div className="mb-12">
              <p className="font-sans text-[10px] tracking-widest uppercase text-muted mb-8">
                Your Pinterest boards
              </p>
              <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-[1.05] mb-4">
                Which board should<br />we shop for you?
              </h1>
              <p className="font-sans text-sm text-muted max-w-sm leading-relaxed">
                Select a board — we&apos;ll decode its aesthetic and find real
                products that match your taste.
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-12">
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
              className="px-8 py-3 bg-foreground text-white font-sans text-xs tracking-widest uppercase hover:bg-accent transition-colors duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {selectedBoard ? `Build my edit →` : "Select a board"}
            </button>
          </div>
        )}

        {/* ── Analyzing ── */}
        {step === "analyzing" && (
          <div className="fade-in flex flex-col items-center justify-center py-40 text-center">
            {/* Thin spinner */}
            <div className="relative w-12 h-12 mb-14">
              <div className="absolute inset-0 rounded-full border border-border" />
              <div className="absolute inset-0 rounded-full border border-transparent border-t-foreground animate-spin" style={{ animationDuration: "1.2s" }} />
            </div>

            <h2 className="font-display font-light text-4xl text-foreground mb-2">
              Building your edit.
            </h2>
            <p className="font-sans text-sm text-muted mb-14">
              About 15 seconds — we&apos;re being thorough.
            </p>

            <div className="flex flex-col gap-5 text-left max-w-xs w-full">
              {analyzingSteps.map(({ label, sub }, i) => (
                <div key={i} className="flex items-start gap-4">
                  <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 transition-colors duration-500 ${
                    i <= analyzeStep ? "bg-foreground" : "bg-border"
                  }`} />
                  <div>
                    <p className={`font-sans text-xs font-medium transition-colors duration-500 ${
                      i <= analyzeStep ? "text-foreground" : "text-muted"
                    }`}>
                      {label}
                    </p>
                    <p className="font-sans text-[11px] text-muted mt-0.5">{sub}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Error ── */}
        {step === "error" && (
          <div className="fade-in flex flex-col items-center justify-center py-40 text-center">
            <h2 className="font-display font-light text-3xl text-foreground mb-3">
              Something went wrong.
            </h2>
            <p className="font-sans text-sm text-muted mb-10 max-w-sm">{errorMsg}</p>
            <button
              onClick={reset}
              className="px-8 py-3 bg-foreground text-white font-sans text-xs tracking-widest uppercase hover:bg-accent transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        {/* ── Results ── */}
        {step === "results" && aesthetic && (
          <div className="fade-in-up">
            {/* Board header */}
            <div className="mb-10">
              <p className="font-sans text-[10px] tracking-widest uppercase text-muted mb-4">
                Personal edit
              </p>
              <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight">
                {selectedBoard?.name}
              </h1>
              {aesthetic.mood && (
                <p className="font-display italic text-lg text-muted mt-1 capitalize">
                  {aesthetic.mood}
                </p>
              )}
            </div>

            {/* Style DNA */}
            <div className="mb-12">
              <StyleDNACard dna={aesthetic} />
            </div>

            {/* Edit header */}
            <div className="flex items-baseline justify-between mb-6 border-t border-border pt-8">
              <h2 className="font-display font-light text-2xl text-foreground">
                Your curated edit
              </h2>
              <p className="font-sans text-[10px] tracking-widest uppercase text-muted">
                {products.length} pieces selected
              </p>
            </div>

            {/* Products */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-14">
              {products.map((product) => (
                <ProductCard key={product.objectID} product={product} />
              ))}
            </div>

            {/* Footer */}
            <div className="border-t border-border pt-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="font-sans text-[11px] text-muted max-w-sm leading-relaxed">
                VITRINE earns a small affiliate commission if you purchase — at no extra cost to you.
              </p>
              <button
                onClick={reset}
                className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors whitespace-nowrap"
              >
                ← Try another board
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
