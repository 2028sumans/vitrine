"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type { StyleDNA, CuratedProduct } from "@/lib/ai";

// ── Mock boards (replaced by real Pinterest boards once API is live) ──────────

const MOCK_BOARDS = [
  { id: "1", name: "Dream Home", pin_count: 142, emoji: "🪴", gradient: "from-[#E8DDD0] to-[#C9B99A]" },
  { id: "2", name: "Fashion Inspo", pin_count: 89, emoji: "👗", gradient: "from-[#D4C5E2] to-[#B39DCC]" },
  { id: "3", name: "Travel Wishlist", pin_count: 64, emoji: "✈️", gradient: "from-[#C5D8E8] to-[#9BBDD4]" },
  { id: "4", name: "Cozy Kitchen", pin_count: 201, emoji: "🫖", gradient: "from-[#E8D5C0] to-[#D4A574]" },
  { id: "5", name: "Beauty & Skin", pin_count: 77, emoji: "🌸", gradient: "from-[#F0D5D5] to-[#E8A8A8]" },
  { id: "6", name: "Outdoor Living", pin_count: 53, emoji: "🌿", gradient: "from-[#C8E0C8] to-[#8FBA8F]" },
];

type Board = (typeof MOCK_BOARDS)[number];
type Step = "boards" | "analyzing" | "results" | "error";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Map a color name to an approximate CSS color for swatches
function colorToCSS(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("ivory") || n.includes("off-white") || n.includes("oatmeal")) return "#FAF3E0";
  if (n.includes("cream")) return "#FFF8DC";
  if (n.includes("white")) return "#F8F8F0";
  if (n.includes("black")) return "#1C1C1C";
  if (n.includes("charcoal")) return "#404040";
  if (n.includes("slate") && !n.includes("blue")) return "#708090";
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
  return "#E0D5C8"; // warm neutral fallback
}

// Badge for each product's outfit role
function OutfitRoleBadge({ role }: { role: string }) {
  const map: Record<string, string> = {
    "statement piece": "bg-stone-800/85 text-stone-50",
    "base layer": "bg-stone-600/85 text-stone-100",
    "layer": "bg-slate-700/85 text-slate-100",
    "going-out look": "bg-zinc-900/90 text-zinc-50",
    "weekend staple": "bg-stone-500/85 text-stone-100",
    "workwear piece": "bg-slate-800/85 text-slate-100",
    "versatile staple": "bg-stone-600/85 text-stone-100",
  };
  const cls = map[role] ?? "bg-black/70 text-white";
  return (
    <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full backdrop-blur-sm ${cls}`}>
      {role}
    </span>
  );
}

// ── Board card ────────────────────────────────────────────────────────────────

function BoardCard({ board, selected, onClick }: { board: Board; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`group relative w-full text-left rounded-2xl overflow-hidden transition-all duration-200 ${
        selected ? "ring-2 ring-accent shadow-lg scale-[1.02]" : "hover:scale-[1.01] hover:shadow-md"
      }`}
    >
      <div className={`w-full aspect-[4/3] bg-gradient-to-br ${board.gradient} flex items-center justify-center`}>
        <span className="text-4xl">{board.emoji}</span>
      </div>
      <div className="bg-white px-4 py-3 border-x border-b border-border rounded-b-2xl">
        <p className="font-semibold text-sm text-foreground truncate">{board.name}</p>
        <p className="text-xs text-muted">{board.pin_count} pins</p>
      </div>
      {selected && (
        <div className="absolute top-3 right-3 w-6 h-6 rounded-full bg-accent flex items-center justify-center shadow">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}
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
      className="group rounded-2xl border border-border bg-white overflow-hidden hover:shadow-xl hover:-translate-y-1 transition-all duration-200 block"
    >
      {/* Image */}
      <div className="aspect-[3/4] bg-gradient-to-br from-[#F5EBE4] to-[#EDD9CC] relative overflow-hidden">
        {product.image_url ? (
          <Image
            src={product.image_url}
            alt={product.title}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            sizes="(max-width: 640px) 50vw, 33vw"
            unoptimized
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-4xl">🛍️</div>
        )}
        {/* Retailer badge — top left */}
        <div className="absolute top-2.5 left-2.5">
          <span className="text-[9px] font-semibold bg-white/90 backdrop-blur-sm text-foreground px-2 py-0.5 rounded-full border border-border/50">
            {product.retailer}
          </span>
        </div>
        {/* Outfit role — top right */}
        {product.outfit_role && (
          <div className="absolute top-2.5 right-2.5">
            <OutfitRoleBadge role={product.outfit_role} />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-4">
        {product.brand && product.brand.toLowerCase() !== product.retailer.toLowerCase() && (
          <p className="text-[10px] font-bold text-accent uppercase tracking-wider mb-0.5">
            {product.brand}
          </p>
        )}
        <p className="font-semibold text-sm text-foreground leading-snug line-clamp-2 mb-2">
          {product.title}
        </p>
        {/* Style note — the stylist's voice */}
        {product.style_note && (
          <p className="text-[11px] text-muted italic leading-relaxed line-clamp-2 mb-3">
            &ldquo;{product.style_note}&rdquo;
          </p>
        )}
        <div className="flex items-center justify-between pt-2 border-t border-border">
          {price ? (
            <span className="text-sm font-bold text-foreground">{price}</span>
          ) : (
            <span />
          )}
          <span className="text-xs font-semibold text-white bg-accent group-hover:bg-accent-light px-3.5 py-1.5 rounded-full transition-colors">
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
    <div className="rounded-2xl bg-white border border-border overflow-hidden">
      {/* Aesthetic name + summary */}
      <div className="px-6 pt-6 pb-5 border-b border-border">
        <p className="text-[10px] font-bold text-accent tracking-widest uppercase mb-3">
          Your Style DNA
        </p>
        <h2 className="text-xl font-bold tracking-tight capitalize leading-snug">
          {dna.primary_aesthetic}
        </h2>
        {dna.secondary_aesthetic && (
          <p className="text-sm text-muted mt-0.5 capitalize">{dna.secondary_aesthetic}</p>
        )}
        <p className="text-sm text-foreground/70 italic mt-3 leading-relaxed">{dna.summary}</p>
      </div>

      {/* Color palette */}
      <div className="px-6 py-4 border-b border-border">
        <p className="text-[10px] font-bold text-muted uppercase tracking-wider mb-3">Your palette</p>
        <div className="flex flex-wrap gap-3">
          {dna.color_palette.map((color) => (
            <div key={color} className="flex items-center gap-1.5">
              <div
                className="w-3.5 h-3.5 rounded-full border border-white shadow ring-1 ring-border flex-shrink-0"
                style={{ backgroundColor: colorToCSS(color) }}
              />
              <span className="text-xs text-foreground capitalize">{color}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Key pieces + avoids */}
      <div className="px-6 py-4 grid grid-cols-2 gap-6 border-b border-border">
        <div>
          <p className="text-[10px] font-bold text-muted uppercase tracking-wider mb-2.5">
            Reaches for
          </p>
          <div className="flex flex-col gap-1.5">
            {(dna.key_pieces ?? []).slice(0, 5).map((piece) => (
              <span key={piece} className="text-xs text-foreground flex items-center gap-2">
                <span className="w-1 h-1 rounded-full bg-accent flex-shrink-0" />
                {piece}
              </span>
            ))}
          </div>
        </div>
        <div>
          <p className="text-[10px] font-bold text-muted uppercase tracking-wider mb-2.5">
            Avoids
          </p>
          <div className="flex flex-col gap-1.5">
            {(dna.avoids ?? []).slice(0, 4).map((avoid) => (
              <span key={avoid} className="text-xs text-muted flex items-center gap-2">
                <span className="w-1 h-1 rounded-full bg-muted/60 flex-shrink-0" />
                {avoid}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Occasion mix */}
      {dna.occasion_mix && (
        <div className="px-6 py-4">
          <p className="text-[10px] font-bold text-muted uppercase tracking-wider mb-3">
            Where you wear it
          </p>
          {/* Stacked bar */}
          <div className="flex h-2 rounded-full overflow-hidden w-full gap-px">
            {dna.occasion_mix.casual > 0 && (
              <div
                style={{ width: `${dna.occasion_mix.casual}%` }}
                className="bg-accent rounded-l-full"
                title={`Casual ${dna.occasion_mix.casual}%`}
              />
            )}
            {dna.occasion_mix.work > 0 && (
              <div
                style={{ width: `${dna.occasion_mix.work}%` }}
                className="bg-accent/65"
                title={`Work ${dna.occasion_mix.work}%`}
              />
            )}
            {dna.occasion_mix.weekend > 0 && (
              <div
                style={{ width: `${dna.occasion_mix.weekend}%` }}
                className="bg-accent/40"
                title={`Weekend ${dna.occasion_mix.weekend}%`}
              />
            )}
            {dna.occasion_mix.going_out > 0 && (
              <div
                style={{ width: `${dna.occasion_mix.going_out}%` }}
                className="bg-accent/20 rounded-r-full"
                title={`Going out ${dna.occasion_mix.going_out}%`}
              />
            )}
          </div>
          <div className="flex gap-4 mt-2.5 flex-wrap">
            {[
              { label: "Casual", pct: dna.occasion_mix.casual },
              { label: "Work", pct: dna.occasion_mix.work },
              { label: "Weekend", pct: dna.occasion_mix.weekend },
              { label: "Going out", pct: dna.occasion_mix.going_out },
            ]
              .filter(({ pct }) => pct > 0)
              .map(({ label, pct }) => (
                <div key={label} className="text-xs text-muted">
                  <span className="font-semibold text-foreground">{pct}%</span>{" "}
                  {label}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const ANALYZING_STEPS = [
  {
    label: "Decoding your aesthetic",
    sub: "Reading colors, textures, silhouettes & mood",
  },
  {
    label: "Searching 40,000+ products",
    sub: "Across ASOS, Nordstrom, Revolve & more",
  },
  {
    label: "Curating your personal edit",
    sub: "Selecting pieces that actually fit your style",
  },
];

export default function DashboardPage() {
  const [step, setStep] = useState<Step>("boards");
  const [selectedBoard, setSelectedBoard] = useState<Board | null>(null);
  const [aesthetic, setAesthetic] = useState<StyleDNA | null>(null);
  const [products, setProducts] = useState<CuratedProduct[]>([]);
  const [dots, setDots] = useState(1);
  const [errorMsg, setErrorMsg] = useState("");

  const handleAnalyze = async () => {
    if (!selectedBoard) return;
    setStep("analyzing");
    setErrorMsg("");

    const interval = setInterval(() => setDots((d) => (d % 3) + 1), 600);

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
      console.error(err);
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong.");
      setStep("error");
    } finally {
      clearInterval(interval);
    }
  };

  const reset = () => {
    setStep("boards");
    setSelectedBoard(null);
    setAesthetic(null);
    setProducts([]);
    setErrorMsg("");
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="px-6 py-4 border-b border-border sticky top-0 bg-background/80 backdrop-blur-md z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-foreground font-bold tracking-tight text-lg">
            Vitrine
          </Link>
          <div className="flex items-center gap-3">
            {step === "results" && (
              <button
                onClick={reset}
                className="text-xs text-muted hover:text-foreground transition-colors"
              >
                ← New board
              </button>
            )}
            <div className="w-8 h-8 rounded-full bg-accent-subtle border border-accent/20 flex items-center justify-center text-accent text-xs font-semibold">
              S
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">

        {/* ── Board selection ── */}
        {step === "boards" && (
          <div className="fade-in-up">
            <div className="mb-10">
              <div className="inline-flex items-center gap-2 bg-accent-subtle border border-accent/20 rounded-full px-3 py-1 mb-4">
                <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                <span className="text-xs text-accent font-medium">Your Pinterest boards</span>
              </div>
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tighter mb-3">
                Which board should<br />we shop for you?
              </h1>
              <p className="text-muted text-lg max-w-md">
                Pick a board and we&apos;ll decode its aesthetic — then find real products that match your taste.
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-10">
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
              className="px-8 py-3.5 rounded-full bg-accent text-white font-semibold text-sm hover:bg-accent-light active:scale-95 transition-all duration-150 shadow-sm disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {selectedBoard
                ? `Build my edit for "${selectedBoard.name}" →`
                : "Select a board to continue"}
            </button>
          </div>
        )}

        {/* ── Analyzing ── */}
        {step === "analyzing" && (
          <div className="fade-in flex flex-col items-center justify-center py-36 text-center">
            <div className="relative w-20 h-20 mb-10">
              <div className="absolute inset-0 rounded-full border-2 border-accent/20" />
              <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-accent animate-spin" />
              <div className="absolute inset-3 rounded-full bg-accent-subtle flex items-center justify-center text-2xl">
                {selectedBoard?.emoji}
              </div>
            </div>

            <h2 className="text-2xl font-bold tracking-tight mb-2">
              Building your edit{".".repeat(dots)}
            </h2>
            <p className="text-muted max-w-xs text-sm">
              This takes about 15 seconds — we&apos;re being thorough.
            </p>

            <div className="mt-10 flex flex-col gap-4 text-left max-w-xs w-full">
              {ANALYZING_STEPS.map(({ label, sub }, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full border border-accent/30 bg-accent-subtle flex items-center justify-center mt-0.5 flex-shrink-0">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{label}</p>
                    <p className="text-xs text-muted">{sub}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Error ── */}
        {step === "error" && (
          <div className="fade-in flex flex-col items-center justify-center py-40 text-center">
            <p className="text-2xl mb-4">😕</p>
            <h2 className="text-xl font-bold tracking-tight mb-2">Something went wrong</h2>
            <p className="text-muted text-sm mb-8 max-w-sm">{errorMsg}</p>
            <button
              onClick={reset}
              className="px-6 py-3 rounded-full bg-accent text-white text-sm font-semibold hover:bg-accent-light transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        {/* ── Results ── */}
        {step === "results" && aesthetic && (
          <div className="fade-in-up">
            {/* Header */}
            <div className="mb-8">
              <div className="inline-flex items-center gap-2 bg-accent-subtle border border-accent/20 rounded-full px-3 py-1 mb-4">
                <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                <span className="text-xs text-accent font-medium">Your personal edit</span>
              </div>
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tighter mb-1">
                {selectedBoard?.name}
              </h1>
              <p className="text-muted capitalize">{aesthetic.mood}</p>
            </div>

            {/* Style DNA card */}
            <div className="mb-10">
              <StyleDNACard dna={aesthetic} />
            </div>

            {/* Section header */}
            <div className="flex items-baseline justify-between mb-5">
              <h2 className="text-lg font-bold tracking-tight">Your curated edit</h2>
              <p className="text-xs text-muted">
                {products.length} piece{products.length !== 1 ? "s" : ""} selected for you
              </p>
            </div>

            {/* Product grid — 2 col mobile, 3 col desktop */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-10">
              {products.map((product) => (
                <ProductCard key={product.objectID} product={product} />
              ))}
            </div>

            {/* Footer */}
            <div className="border-t border-border pt-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-xs text-muted">
                Vitrine earns a small affiliate commission if you purchase — at no extra cost to you.
              </p>
              <button
                onClick={reset}
                className="text-xs font-semibold text-accent hover:text-accent-light transition-colors whitespace-nowrap"
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
