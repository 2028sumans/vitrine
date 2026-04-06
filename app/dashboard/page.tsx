"use client";

import { useState } from "react";
import Link from "next/link";

const MOCK_BOARDS = [
  { id: "1", name: "Dream Home", pin_count: 142, emoji: "🪴", gradient: "from-[#E8DDD0] to-[#C9B99A]" },
  { id: "2", name: "Fashion Inspo", pin_count: 89, emoji: "👗", gradient: "from-[#D4C5E2] to-[#B39DCC]" },
  { id: "3", name: "Travel Wishlist", pin_count: 64, emoji: "✈️", gradient: "from-[#C5D8E8] to-[#9BBDD4]" },
  { id: "4", name: "Cozy Kitchen", pin_count: 201, emoji: "🫖", gradient: "from-[#E8D5C0] to-[#D4A574]" },
  { id: "5", name: "Beauty & Skin", pin_count: 77, emoji: "🌸", gradient: "from-[#F0D5D5] to-[#E8A8A8]" },
  { id: "6", name: "Outdoor Living", pin_count: 53, emoji: "🌿", gradient: "from-[#C8E0C8] to-[#8FBA8F]" },
];

const MOCK_PRODUCTS = [
  { id: "p1", name: "Linen Throw Pillow", price: "$38", retailer: "West Elm", emoji: "🛋️", tag: "Perfect match" },
  { id: "p2", name: "Ceramic Table Lamp", price: "$124", retailer: "CB2", emoji: "💡", tag: "Trending" },
  { id: "p3", name: "Rattan Side Table", price: "$89", retailer: "Article", emoji: "🪑", tag: "Perfect match" },
  { id: "p4", name: "Boucle Accent Chair", price: "$445", retailer: "Wayfair", emoji: "🪑", tag: null },
  { id: "p5", name: "Woven Wall Hanging", price: "$62", retailer: "Etsy", emoji: "🖼️", tag: "Handmade" },
  { id: "p6", name: "Arch Floor Mirror", price: "$279", retailer: "H&M Home", emoji: "🪞", tag: null },
];

type Board = (typeof MOCK_BOARDS)[number];
type Step = "boards" | "analyzing" | "results";

function BoardCard({ board, selected, onClick }: { board: Board; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`group relative w-full text-left rounded-2xl overflow-hidden transition-all duration-200 ${
        selected ? "ring-2 ring-accent shadow-lg scale-[1.02]" : "hover:scale-[1.01] hover:shadow-md"
      }`}
    >
      {/* Gradient cover */}
      <div className={`w-full aspect-[4/3] bg-gradient-to-br ${board.gradient} flex items-center justify-center`}>
        <span className="text-4xl">{board.emoji}</span>
      </div>

      {/* Info */}
      <div className="bg-white px-4 py-3 border-x border-b border-border rounded-b-2xl">
        <p className="font-semibold text-sm text-foreground truncate">{board.name}</p>
        <p className="text-xs text-muted">{board.pin_count} pins</p>
      </div>

      {/* Selected checkmark */}
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

function ProductCard({ product }: { product: (typeof MOCK_PRODUCTS)[number] }) {
  return (
    <div className="group rounded-2xl border border-border bg-white overflow-hidden hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200">
      {/* Image area */}
      <div className="aspect-square bg-gradient-to-br from-[#F5EBE4] to-[#EDD9CC] flex items-center justify-center relative">
        <span className="text-5xl">{product.emoji}</span>
        {product.tag && (
          <span className="absolute top-3 left-3 text-[10px] font-semibold bg-white/90 text-accent px-2.5 py-1 rounded-full border border-accent/20">
            {product.tag}
          </span>
        )}
      </div>

      {/* Details */}
      <div className="p-4">
        <p className="font-semibold text-sm text-foreground leading-tight mb-0.5">{product.name}</p>
        <p className="text-xs text-muted mb-3">{product.retailer}</p>
        <div className="flex items-center justify-between">
          <span className="text-base font-bold text-foreground">{product.price}</span>
          <button className="text-xs font-semibold text-white bg-accent hover:bg-accent-light px-3.5 py-1.5 rounded-full transition-colors">
            Shop
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [step, setStep] = useState<Step>("boards");
  const [selectedBoard, setSelectedBoard] = useState<Board | null>(null);
  const [dots, setDots] = useState(1);

  const handleAnalyze = () => {
    if (!selectedBoard) return;
    setStep("analyzing");
    const interval = setInterval(() => setDots((d) => (d % 3) + 1), 600);
    setTimeout(() => {
      clearInterval(interval);
      setStep("results");
    }, 3000);
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
                onClick={() => { setStep("boards"); setSelectedBoard(null); }}
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
            {/* Header */}
            <div className="mb-10">
              <div className="inline-flex items-center gap-2 bg-accent-subtle border border-accent/20 rounded-full px-3 py-1 mb-4">
                <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                <span className="text-xs text-accent font-medium">Your Pinterest boards</span>
              </div>
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tighter mb-3">
                Which board should<br />we shop for you?
              </h1>
              <p className="text-muted text-lg max-w-md">
                Pick a board and we&apos;ll analyze its aesthetic to find products that actually match your taste.
              </p>
            </div>

            {/* Board grid */}
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

            {/* CTA */}
            <div className="flex items-center gap-4">
              <button
                onClick={handleAnalyze}
                disabled={!selectedBoard}
                className="px-8 py-3.5 rounded-full bg-accent text-white font-semibold text-sm hover:bg-accent-light active:scale-95 transition-all duration-150 shadow-sm disabled:opacity-30 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                {selectedBoard ? `Analyze "${selectedBoard.name}" →` : "Select a board to continue"}
              </button>
            </div>
          </div>
        )}

        {/* ── Analyzing ── */}
        {step === "analyzing" && (
          <div className="fade-in flex flex-col items-center justify-center py-40 text-center">
            {/* Animated ring */}
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

            {/* Progress steps */}
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

        {/* ── Results ── */}
        {step === "results" && (
          <div className="fade-in-up">
            {/* Header */}
            <div className="mb-8">
              <div className="inline-flex items-center gap-2 bg-accent-subtle border border-accent/20 rounded-full px-3 py-1 mb-4">
                <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                <span className="text-xs text-accent font-medium">Your shopping page</span>
              </div>
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tighter mb-3">
                {selectedBoard?.name}
              </h1>

              {/* Aesthetic summary */}
              <div className="mt-6 p-5 rounded-2xl bg-white border border-border max-w-2xl">
                <p className="text-xs font-semibold text-accent tracking-widest uppercase mb-2">
                  Aesthetic analysis
                </p>
                <p className="text-sm text-muted leading-relaxed">
                  Your <strong className="text-foreground">{selectedBoard?.name}</strong> board has a warm, organic feel —
                  natural textures, muted earth tones, and a mix of vintage and modern pieces.
                  Think linen, rattan, terracotta, and soft lighting. We found{" "}
                  <strong className="text-foreground">{MOCK_PRODUCTS.length} products</strong> that match this vibe.
                </p>
              </div>
            </div>

            {/* Product grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
              {MOCK_PRODUCTS.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>

            {/* Footer note */}
            <p className="text-xs text-muted text-center border-t border-border pt-6">
              Vitrine earns a small affiliate commission if you make a purchase — at no cost to you.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
