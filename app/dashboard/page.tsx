"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import type { StyleDNA, CuratedProduct } from "@/lib/ai";
import { getUserToken, trackProductClick, trackProductsViewed } from "@/lib/insights";

// ── Types ─────────────────────────────────────────────────────────────────────

type Board   = { id: string; name: string };
type Step    = "boards" | "analyzing" | "results" | "error";

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

// ── Pin grid — auto-loaded from Pinterest ─────────────────────────────────────

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
      <div className="grid grid-cols-6 gap-1">
        {pins.slice(0, 12).map((pin) => (
          <div key={pin.id} className="aspect-square overflow-hidden bg-white/5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pin.thumbUrl}
              alt={pin.title}
              className="w-full h-full object-cover opacity-80"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Product card ──────────────────────────────────────────────────────────────

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
    // Algolia Insights — feeds Dynamic Re-Ranking + Personalization
    trackProductClick({
      userToken,
      objectID: product.objectID,
      queryID:  product._queryID ?? "",
      position,
    });
    // Taste memory — feeds living StyleDNA + click-as-ground-truth
    fetch("/api/taste/click", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userToken,
        product: {
          objectID:   product.objectID,
          title:      product.title,
          brand:      product.brand,
          color:      product.color,
          category:   product.category,
          retailer:   product.retailer,
          price_range: product.price_range,
          image_url:  product.image_url,
        },
      }),
    }).catch(() => {/* non-fatal */});
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
  label,
  role,
  products,
  startPosition,
  userToken,
}: {
  label:         string;
  role?:         string;
  products:      CuratedProduct[];
  startPosition: number;
  userToken:     string;
}) {
  if (products.length === 0) return null;
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
          <ProductCard
            key={p.objectID}
            product={p}
            position={startPosition + i}
            userToken={userToken}
          />
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

// ── Page ──────────────────────────────────────────────────────────────────────

const ANALYZING_STEPS = [
  { label: "Reading your aesthetic",    sub: "Colors, textures, silhouettes & mood" },
  { label: "Finding candidates",        sub: "48 products across 6 categories" },
  { label: "Shortlisting finalists",    sub: "Narrowing to the 12 strongest fits" },
  { label: "Seeing the products",       sub: "Claude views each image, builds outfits" },
  { label: "Writing your edit",         sub: "Styling notes & editorial intro" },
];

export default function DashboardPage() {
  const { data: session } = useSession();
  const [step, setStep]                     = useState<Step>("boards");
  const [boards, setBoards]                 = useState<Board[]>([]);
  const [boardsLoading, setBoardsLoading]   = useState(true);
  const [selectedBoard, setSelectedBoard]   = useState<Board | null>(null);
  const [pins, setPins]                     = useState<PinData[]>([]);
  const [pinsLoading, setPinsLoading]       = useState(false);
  const [aesthetic, setAesthetic]           = useState<StyleDNA | null>(null);
  const [products, setProducts]             = useState<CuratedProduct[]>([]);
  const [editorialIntro, setEditorialIntro] = useState("");
  const [editRationale, setEditRationale]   = useState("");
  const [outfitArc, setOutfitArc]           = useState("");
  const [outfitARole, setOutfitARole]       = useState("");
  const [outfitBRole, setOutfitBRole]       = useState("");
  const [analyzeStep, setAnalyzeStep]       = useState(0);
  const [errorMsg, setErrorMsg]             = useState("");
  const [userToken, setUserToken]           = useState("anon");

  // Use Pinterest user ID as userToken when authenticated; fall back to localStorage anon token
  useEffect(() => {
    if (session?.user?.id) {
      setUserToken(session.user.id);
    } else {
      setUserToken(getUserToken());
    }
  }, [session]);

  // Fetch real Pinterest boards from the API
  useEffect(() => {
    setBoardsLoading(true);
    fetch("/api/pinterest/boards")
      .then((r) => r.json())
      .then((data) => {
        if (data.boards?.length) setBoards(data.boards);
      })
      .catch(() => {/* non-fatal */})
      .finally(() => setBoardsLoading(false));
  }, []);

  // Auto-fetch pins when a board is selected
  useEffect(() => {
    if (!selectedBoard) { setPins([]); return; }
    setPins([]);
    setPinsLoading(true);
    fetch(`/api/pinterest/pins?boardId=${selectedBoard.id}`)
      .then((r) => r.json())
      .then((data) => { if (data.pins?.length) setPins(data.pins); })
      .catch(() => {/* non-fatal */})
      .finally(() => setPinsLoading(false));
  }, [selectedBoard]);

  // Fire view events when results arrive — builds personalization profile
  useEffect(() => {
    if (step === "results" && products.length > 0) {
      trackProductsViewed({
        userToken,
        objectIDs: products.map((p) => p.objectID),
      });
    }
  }, [step, products, userToken]);

  const handleAnalyze = useCallback(async () => {
    if (!selectedBoard) return;
    setStep("analyzing");
    setErrorMsg("");
    setAnalyzeStep(0);

    const t1 = setTimeout(() => setAnalyzeStep(1), 10000);
    const t2 = setTimeout(() => setAnalyzeStep(2), 14000);
    const t3 = setTimeout(() => setAnalyzeStep(3), 20000);
    const t4 = setTimeout(() => setAnalyzeStep(4), 28000);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardId:      selectedBoard.id,
          boardName:    selectedBoard.name,
          pins:         pins.map((p) => ({ title: p.title, description: p.description })),
          pinImageUrls: pins.slice(0, 12).map((p) => p.imageUrl),
          userToken,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? "Analysis failed");

      setAesthetic(data.aesthetic);
      setProducts(data.products);
      setEditorialIntro(data.editorial_intro ?? "");
      setEditRationale(data.edit_rationale ?? "");
      setOutfitArc(data.outfit_arc ?? "");
      setOutfitARole(data.outfit_a_role ?? "");
      setOutfitBRole(data.outfit_b_role ?? "");
      setStep("results");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong.");
      setStep("error");
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    }
  }, [selectedBoard, pins, userToken]);

  const reset = () => {
    setStep("boards");
    setSelectedBoard(null);
    setPins([]);
    setAesthetic(null);
    setProducts([]);
    setEditorialIntro("");
    setEditRationale("");
    setOutfitArc("");
    setOutfitARole("");
    setOutfitBRole("");
    setErrorMsg("");
    setAnalyzeStep(0);
  };

  const outfitA = products.filter((p) => p.outfit_group === "outfit_a");
  const outfitB = products.filter((p) => p.outfit_group === "outfit_b");

  return (
    <div className="min-h-screen bg-background text-foreground">
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
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              title="Sign out"
              className="w-7 h-7 border border-border flex items-center justify-center font-sans text-[10px] text-muted hover:border-border-mid hover:text-foreground transition-colors overflow-hidden"
            >
              {session?.user?.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={session.user.image} alt="" className="w-full h-full object-cover" />
              ) : (
                (session?.user?.name?.[0] ?? "S").toUpperCase()
              )}
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

            {/* Pin grid — auto-loaded when board is selected */}
            {selectedBoard && (
              <div className="border border-t-0 border-border px-5 pb-6">
                <PinGrid pins={pins} loading={pinsLoading} />
              </div>
            )}

            <div className="mt-8">
              <button
                onClick={handleAnalyze}
                disabled={!selectedBoard || pinsLoading}
                className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200 disabled:opacity-25 disabled:cursor-not-allowed"
              >
                {!selectedBoard ? "Select a board" : pinsLoading ? "Loading pins…" : "Build my edit →"}
              </button>
              {selectedBoard && !pinsLoading && pins.length === 0 && (
                <p className="font-sans text-[11px] text-muted mt-3">
                  No pins found — we&apos;ll infer your aesthetic from the board name.
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── Analyzing ── */}
        {step === "analyzing" && (
          <div className="fade-in flex flex-col items-center justify-center py-40 text-center">
            <div className="relative w-10 h-10 mb-16">
              <div className="absolute inset-0 rounded-full border border-border" />
              <div className="absolute inset-0 rounded-full border border-transparent border-t-foreground/60 animate-spin" style={{ animationDuration: "1.4s" }} />
            </div>
            <h2 className="font-display font-light text-4xl text-foreground mb-2">Building your edit.</h2>
            <p className="font-sans text-base text-muted-strong mb-16">About 35 seconds — being thorough.</p>
            <div className="flex flex-col gap-6 text-left max-w-xs w-full">
              {ANALYZING_STEPS.map(({ label, sub }, i) => (
                <div key={i} className="flex items-start gap-4">
                  <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 transition-all duration-700 ${
                    i < analyzeStep ? "bg-accent" : i === analyzeStep ? "bg-foreground/80 shadow-[0_0_6px_rgba(240,232,216,0.4)]" : "bg-foreground/15"
                  }`} />
                  <div>
                    <p className={`font-sans text-xs transition-colors duration-500 ${i <= analyzeStep ? "text-foreground" : "text-muted/50"}`}>{label}</p>
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
            <button onClick={reset} className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors">Try again</button>
          </div>
        )}

        {/* ── Results ── */}
        {step === "results" && aesthetic && (
          <div className="fade-in-up">
            <div className="mb-12">
              <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-5">Personal edit</p>
              <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight">{selectedBoard?.name}</h1>
              {aesthetic.mood && <p className="font-display italic text-xl text-muted mt-1.5 capitalize">{aesthetic.mood}</p>}
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
