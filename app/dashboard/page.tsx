"use client";

import { useState } from "react";
import Link from "next/link";

// ── Mock data (replace with real Pinterest API calls once approved) ──
const MOCK_BOARDS = [
  { id: "1", name: "Dream Home", pin_count: 142, cover: null },
  { id: "2", name: "Fashion Inspo", pin_count: 89, cover: null },
  { id: "3", name: "Travel Wishlist", pin_count: 64, cover: null },
  { id: "4", name: "Cozy Kitchen", pin_count: 201, cover: null },
];

const MOCK_PRODUCTS = [
  {
    id: "p1",
    name: "Linen Throw Pillow",
    price: "$38",
    retailer: "West Elm",
    image: null,
  },
  {
    id: "p2",
    name: "Ceramic Table Lamp",
    price: "$124",
    retailer: "CB2",
    image: null,
  },
  {
    id: "p3",
    name: "Rattan Side Table",
    price: "$89",
    retailer: "Article",
    image: null,
  },
  {
    id: "p4",
    name: "Boucle Accent Chair",
    price: "$445",
    retailer: "Wayfair",
    image: null,
  },
  {
    id: "p5",
    name: "Woven Wall Hanging",
    price: "$62",
    retailer: "Etsy",
    image: null,
  },
  {
    id: "p6",
    name: "Arch Floor Mirror",
    price: "$279",
    retailer: "H&M Home",
    image: null,
  },
];

type Board = (typeof MOCK_BOARDS)[number];

function BoardCard({
  board,
  selected,
  onClick,
}: {
  board: Board;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-2xl border p-5 transition-all duration-150 ${
        selected
          ? "border-accent bg-accent-subtle shadow-sm"
          : "border-border bg-white hover:border-accent/40 hover:bg-accent-subtle/40"
      }`}
    >
      {/* Board cover placeholder */}
      <div className="w-full aspect-[4/3] rounded-lg bg-gradient-to-br from-border to-background mb-4 flex items-center justify-center">
        <span className="text-3xl opacity-20">📌</span>
      </div>
      <p className="font-semibold text-sm tracking-tight text-foreground truncate">
        {board.name}
      </p>
      <p className="text-xs text-muted mt-0.5">{board.pin_count} pins</p>
      {selected && (
        <span className="inline-flex items-center gap-1 mt-2 text-xs text-accent font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-accent" />
          Selected
        </span>
      )}
    </button>
  );
}

function ProductCard({ product }: { product: (typeof MOCK_PRODUCTS)[number] }) {
  return (
    <div className="rounded-2xl border border-border bg-white overflow-hidden group hover:shadow-md transition-all duration-150">
      <div className="aspect-square bg-gradient-to-br from-border/50 to-background flex items-center justify-center">
        <span className="text-4xl opacity-20">🛍</span>
      </div>
      <div className="p-4">
        <p className="font-medium text-sm text-foreground leading-tight">
          {product.name}
        </p>
        <p className="text-xs text-muted mt-0.5">{product.retailer}</p>
        <div className="flex items-center justify-between mt-3">
          <span className="text-sm font-semibold text-foreground">
            {product.price}
          </span>
          <button className="text-xs text-accent font-medium hover:underline">
            Shop →
          </button>
        </div>
      </div>
    </div>
  );
}

type Step = "boards" | "analyzing" | "results";

export default function DashboardPage() {
  const [step, setStep] = useState<Step>("boards");
  const [selectedBoard, setSelectedBoard] = useState<Board | null>(null);

  const handleAnalyze = () => {
    if (!selectedBoard) return;
    setStep("analyzing");
    // Simulate analysis delay — replace with real API call
    setTimeout(() => setStep("results"), 3000);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="px-6 py-5 border-b border-border sticky top-0 bg-background/80 backdrop-blur-sm z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link
            href="/"
            className="text-foreground font-semibold tracking-tight text-lg"
          >
            Vitrine
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted">My Shopping Page</span>
            <button className="text-xs text-muted hover:text-foreground transition-colors border border-border rounded-full px-3 py-1.5">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        {/* ── Step: Select a board ── */}
        {step === "boards" && (
          <div className="fade-in-up">
            <div className="mb-10">
              <p className="text-accent text-sm font-medium tracking-widest uppercase mb-2">
                Step 1
              </p>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
                Pick a board to shop.
              </h1>
              <p className="text-muted text-lg">
                Choose one of your Pinterest boards. We&apos;ll analyze its
                aesthetic and find real products that match your taste.
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
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
              className="px-8 py-3.5 rounded-full bg-accent text-white font-semibold text-sm hover:bg-accent-light active:scale-95 transition-all duration-150 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Analyze this board →
            </button>
          </div>
        )}

        {/* ── Step: Analyzing ── */}
        {step === "analyzing" && (
          <div className="fade-in flex flex-col items-center justify-center py-32 text-center">
            <div className="w-14 h-14 rounded-full border-2 border-accent border-t-transparent animate-spin mb-8" />
            <h2 className="text-2xl font-bold tracking-tight mb-2">
              Analyzing your taste…
            </h2>
            <p className="text-muted max-w-sm">
              Reading the aesthetic of your{" "}
              <span className="text-foreground font-medium">
                {selectedBoard?.name}
              </span>{" "}
              board — colors, mood, style. This takes a few seconds.
            </p>
          </div>
        )}

        {/* ── Step: Results ── */}
        {step === "results" && (
          <div className="fade-in-up">
            <div className="mb-10 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <p className="text-accent text-sm font-medium tracking-widest uppercase mb-2">
                  Your shopping page
                </p>
                <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-2">
                  {selectedBoard?.name}
                </h1>
                <p className="text-muted">
                  Products matched to your board&apos;s aesthetic. Click to shop.
                </p>
              </div>
              <button
                onClick={() => {
                  setStep("boards");
                  setSelectedBoard(null);
                }}
                className="text-sm text-muted hover:text-foreground transition-colors border border-border rounded-full px-4 py-2 w-fit"
              >
                ← Try another board
              </button>
            </div>

            {/* Aesthetic summary card */}
            <div className="mb-8 p-6 rounded-2xl bg-accent-subtle border border-accent/20">
              <p className="text-xs text-accent font-medium tracking-widest uppercase mb-2">
                Aesthetic analysis
              </p>
              <p className="text-foreground text-sm leading-relaxed">
                Your <strong>{selectedBoard?.name}</strong> board has a warm,
                organic feel — natural textures, muted earth tones, and a mix of
                vintage and modern pieces. Think linen, rattan, terracotta, and
                soft lighting. We found products that match this vibe.
              </p>
            </div>

            {/* Product grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {MOCK_PRODUCTS.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>

            <p className="text-xs text-muted text-center mt-8">
              Vitrine earns a small affiliate commission if you make a purchase.
              Prices shown are approximate.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
