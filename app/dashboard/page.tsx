"use client";

import { useState } from "react";
import Link from "next/link";
import type { AestheticProfile, ProductRecommendation } from "@/lib/ai";

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

function ProductCard({ product }: { product: ProductRecommendation }) {
  return (
    <a
      href={product.amazon_url}
      target="_blank"
      rel="noopener noreferrer"
      className="group rounded-2xl border border-border bg-white overflow-hidden hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 block"
    >
      <div className="aspect-square bg-gradient-to-br from-[#F5EBE4] to-[#EDD9CC] flex flex-col items-center justify-center gap-2 relative p-4">
        <span className="text-3xl">🛍️</span>
        <span className="text-[10px] font-semibold bg-white/90 text-accent px-2.5 py-1 rounded-full border border-accent/20 text-center">
          {product.category}
        </span>
      </div>
      <div className="p-4">
        <p className="font-semibold text-sm text-foreground leading-tight mb-1">{product.name}</p>
        <p className="text-xs text-muted leading-relaxed mb-3 line-clamp-2">{product.description}</p>
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-foreground">{product.price_range}</span>
          <span className="text-xs font-semibold text-white bg-accent hover:bg-accent-light px-3.5 py-1.5 rounded-full transition-colors">
            Shop →
          </span>
        </div>
        <p className="text-xs text-muted mt-2">{product.retailers.join(", ")}</p>
      </div>
    </a>
  );
}

export default function DashboardPage() {
  const [step, setStep] = useState<Step>("boards");
  const [selectedBoard, setSelectedBoard] = useState<Board | null>(null);
  const [aesthetic, setAesthetic] = useState<AestheticProfile | null>(null);
  const [products, setProducts] = useState<ProductRecommendation[]>([]);
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
          pins: [], // real pins will come from Pinterest API once approved
        }),
      });

      if (!res.ok) throw new Error("Analysis failed");

      const data = await res.json();
      setAesthetic(data.aesthetic);
      setProducts(data.products);
      setStep("results");
    } catch (err) {
      console.error(err);
      setErrorMsg("Something went wrong. Please try again.");
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
              <button onClick={reset} className="text-xs text-muted hover:text-foreground transition-colors">
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
                Pick a board and we&apos;ll analyze its aesthetic to find products that match your taste.
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
              {selectedBoard ? `Analyze "${selectedBoard.name}" →` : "Select a board to continue"}
            </button>
          </div>
        )}

        {/* ── Analyzing ── */}
        {step === "analyzing" && (
          <div className="fade-in flex flex-col items-center justify-center py-40 text-center">
            <div className="relative w-20 h-20 mb-10">
              <div className="absolute inset-0 rounded-full border-2 border-accent/20" />
              <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-accent animate-spin" />
              <div className="absolute inset-3 rounded-full bg-accent-subtle flex items-center justify-center text-2xl">
                {selectedBoard?.emoji}
              </div>
            </div>
            <h2 className="text-2xl font-bold tracking-tight mb-2">
              Analyzing your taste{".".repeat(dots)}
            </h2>
            <p className="text-muted max-w-xs text-sm leading-relaxed">
              Reading the colors, textures, and mood of your{" "}
              <span className="text-foreground font-medium">{selectedBoard?.name}</span> board.
            </p>
            <div className="mt-10 flex flex-col gap-2 text-left">
              {["Reading your pins", "Understanding the aesthetic", "Matching products"].map((label, i) => (
                <div key={i} className="flex items-center gap-3 text-sm text-muted">
                  <div className="w-4 h-4 rounded-full border border-accent/30 bg-accent-subtle flex items-center justify-center">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                  </div>
                  {label}
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
            <p className="text-muted text-sm mb-8">{errorMsg}</p>
            <button onClick={reset} className="px-6 py-3 rounded-full bg-accent text-white text-sm font-semibold hover:bg-accent-light transition-colors">
              Try again
            </button>
          </div>
        )}

        {/* ── Results ── */}
        {step === "results" && aesthetic && (
          <div className="fade-in-up">
            <div className="mb-8">
              <div className="inline-flex items-center gap-2 bg-accent-subtle border border-accent/20 rounded-full px-3 py-1 mb-4">
                <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                <span className="text-xs text-accent font-medium">Your shopping page</span>
              </div>
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tighter mb-3">
                {selectedBoard?.name}
              </h1>

              {/* Aesthetic card */}
              <div className="mt-6 p-5 rounded-2xl bg-white border border-border max-w-2xl">
                <p className="text-xs font-semibold text-accent tracking-widest uppercase mb-3">
                  Aesthetic analysis
                </p>
                <p className="text-sm text-foreground font-semibold mb-1">{aesthetic.mood}</p>
                <p className="text-sm text-muted leading-relaxed mb-3">{aesthetic.summary}</p>
                <div className="flex flex-wrap gap-2">
                  {aesthetic.style_keywords.map((kw) => (
                    <span key={kw} className="text-xs bg-accent-subtle text-accent px-2.5 py-1 rounded-full border border-accent/20">
                      {kw}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Product grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
              {products.map((product) => (
                <ProductCard key={product.name} product={product} />
              ))}
            </div>

            <p className="text-xs text-muted text-center border-t border-border pt-6">
              Vitrine earns a small affiliate commission if you make a purchase — at no cost to you.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
