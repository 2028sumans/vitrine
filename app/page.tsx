"use client";

import { useState } from "react";
import Link from "next/link";

// ── Waitlist form ─────────────────────────────────────────────────────────────

function WaitlistForm({ onCream = false }: { onCream?: boolean }) {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    try {
      await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
    } catch {
      // fail silently
    } finally {
      setLoading(false);
      setSubmitted(true);
    }
  };

  if (submitted) {
    return (
      <p className={`fade-in font-sans text-sm tracking-wide ${onCream ? "text-navy-muted" : "text-muted-strong"}`}>
        You&apos;re on the list.
      </p>
    );
  }

  if (onCream) {
    return (
      <form onSubmit={handleSubmit} className="w-full max-w-sm">
        <label className="sr-only">Email address</label>
        <div className="flex">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            required
            className="flex-1 px-4 py-3 text-sm font-sans bg-white/60 border border-navy-border text-navy placeholder-navy/30 focus:outline-none focus:border-navy-border-mid transition-colors"
          />
          <button
            type="submit"
            disabled={loading}
            className="px-5 py-3 bg-navy text-cream font-sans text-[10px] tracking-widest uppercase font-medium whitespace-nowrap hover:bg-navy/80 transition-colors duration-200 disabled:opacity-50"
          >
            {loading ? "…" : "Join the waitlist"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm">
      <label className="sr-only">Email address</label>
      <div className="flex">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          required
          className="flex-1 px-4 py-3 text-sm font-sans bg-white/6 border border-border text-foreground placeholder-foreground/25 focus:outline-none focus:border-border-mid transition-colors"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-5 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase font-medium whitespace-nowrap hover:bg-accent hover:text-background transition-colors duration-200 disabled:opacity-50"
        >
          {loading ? "…" : "Join the waitlist"}
        </button>
      </div>
    </form>
  );
}

// ── Data ──────────────────────────────────────────────────────────────────────

const steps = [
  {
    num: "I",
    title: "Connect your Pinterest",
    body: "Link your account in one tap. We read your boards with your permission, and nothing else.",
  },
  {
    num: "II",
    title: "We decode your aesthetic",
    body: "Our AI identifies the exact aesthetic, palette, silhouettes, and mood across your boards, with a fashion stylist's eye.",
  },
  {
    num: "III",
    title: "Shop your own taste",
    body: "Receive a private, personally curated page. Real products from real retailers, edited to match exactly what you love.",
  },
];

const features = [
  {
    label: "Named aesthetic",
    body: "Not just 'minimalist'. Think quiet luxury, coastal grandmother, dark academia, clean girl. A real style identity.",
  },
  {
    label: "Your color palette",
    body: "Dusty sage. Warm ivory. Slate blue. Specific colors, not generic descriptions.",
  },
  {
    label: "Curated by AI",
    body: "A stylist AI selects each piece individually, filtered by fit, color coherence, and what you actively avoid.",
  },
  {
    label: "Real retailers",
    body: "ASOS, Nordstrom, Revolve, Bloomingdale's and more, filtered to match your exact budget.",
  },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col">

      {/* ── Nav — floats over hero (navy) ── */}
      <header className="fade-in fixed top-0 left-0 right-0 z-50 px-8 py-5 flex items-center justify-between">
        <span className="font-display font-light text-xl tracking-[0.22em] text-foreground">
          VITRINE
        </span>
        <Link
          href="/dashboard"
          className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors duration-200"
        >
          Try demo
        </Link>
      </header>

      <main className="flex-1">

        {/* ══ 1. HERO — NAVY ══════════════════════════════════════════════════ */}
        <section className="relative min-h-screen flex flex-col items-center justify-center text-center px-6 overflow-hidden bg-background">

          {/* Radial glow */}
          <div className="absolute inset-0 pointer-events-none"
            style={{ background: "radial-gradient(ellipse 80% 60% at 50% 55%, rgba(201,185,154,0.07) 0%, transparent 70%)" }}
          />
          {/* Grid texture */}
          <div className="absolute inset-0 pointer-events-none opacity-[0.025]"
            style={{
              backgroundImage: "linear-gradient(rgba(240,232,216,1) 1px, transparent 1px), linear-gradient(90deg, rgba(240,232,216,1) 1px, transparent 1px)",
              backgroundSize: "80px 80px",
            }}
          />

          <div className="relative z-10 max-w-4xl mx-auto">
            <p className="fade-in font-sans text-[10px] tracking-widest uppercase text-muted mb-12">
              Coming Soon
            </p>

            <h1 className="fade-in-up delay-100 font-display font-light text-[clamp(72px,14vw,160px)] leading-[0.9] tracking-[0.1em] text-foreground mb-10">
              VITRINE
            </h1>

            <p className="fade-in-up delay-200 font-display font-light italic text-2xl sm:text-3xl text-foreground/60 mb-5 leading-snug">
              Your taste, made shoppable.
            </p>

            <p className="fade-in-up delay-300 font-sans text-base text-muted-strong max-w-md mx-auto leading-relaxed mb-14">
              VITRINE reads your Pinterest boards and builds you a private
              shopping page, curated by an AI stylist that understands exactly
              what you love.
            </p>

            <div className="fade-in-up delay-400 flex flex-col items-center gap-4">
              <WaitlistForm onCream={false} />
            </div>
          </div>
        </section>

        {/* ══ 2. HOW IT WORKS — CREAM ═════════════════════════════════════════ */}
        <section className="bg-cream px-8 py-28 max-w-full">
          <div className="max-w-6xl mx-auto">
            <div className="mb-20">
              <p className="font-sans text-[9px] tracking-widest uppercase text-navy-muted mb-4">
                How it works
              </p>
              <h2 className="font-display font-light text-5xl sm:text-6xl text-navy leading-tight">
                Three steps.
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-12 sm:gap-8">
              {steps.map((step) => (
                <div key={step.num}>
                  <p className="font-display font-light text-6xl text-navy/40 mb-6 leading-none select-none">
                    {step.num}
                  </p>
                  <h3 className="font-display font-light text-3xl text-navy mb-3 leading-snug">
                    {step.title}
                  </h3>
                  <p className="font-sans text-base text-navy-strong leading-relaxed">
                    {step.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ══ 3. STATEMENT — NAVY ═════════════════════════════════════════════ */}
        <section className="bg-background px-8 py-32">
          <div className="max-w-6xl mx-auto">
            <div className="max-w-3xl">
              <h2 className="font-display font-light text-4xl sm:text-5xl md:text-6xl leading-[1.1] text-foreground mb-8">
                Built for the woman who has been pinning for years and never
                found all of it in one place.
              </h2>
              <p className="font-sans text-base text-muted-strong leading-relaxed max-w-lg">
                Your boards already say everything. VITRINE listens and finds
                the exact pieces that match the aesthetic you&apos;ve been
                quietly, carefully building.
              </p>
            </div>
          </div>
        </section>

        {/* ══ 4. FEATURES — CREAM ═════════════════════════════════════════════ */}
        <section className="bg-cream px-8 py-24">
          <div className="max-w-6xl mx-auto">
            <p className="font-sans text-[9px] tracking-widest uppercase text-navy-muted mb-14">
              What you get
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-16 gap-y-10">
              {features.map(({ label, body }) => (
                <div key={label} className="flex gap-6 items-start">
                  <div className="w-px h-10 bg-navy-border-mid flex-shrink-0 mt-0.5" />
                  <div>
                    <h3 className="font-display font-light text-xl text-navy mb-2">
                      {label}
                    </h3>
                    <p className="font-sans text-base text-navy-strong leading-relaxed">
                      {body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Transparency note */}
        <div className="bg-background border-t border-border">
          <div className="max-w-6xl mx-auto px-8 py-10 flex items-start gap-8">
            <p className="font-sans text-[9px] tracking-widest uppercase text-muted-dim mt-0.5 whitespace-nowrap">
              Note
            </p>
            <p className="font-sans text-xs text-muted leading-relaxed max-w-md">
              VITRINE is free. We earn a small affiliate commission when you
              purchase through your page, at no cost to you. We never sell your
              data.
            </p>
          </div>
        </div>
      </main>

      {/* ══ FOOTER — CREAM ══════════════════════════════════════════════════ */}
      <footer className="bg-background border-t border-border px-8 py-7">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="font-display font-light tracking-[0.18em] text-sm text-muted">
            VITRINE
          </span>
          <div className="flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase text-muted-dim">
            <Link href="/privacy" className="hover:text-foreground transition-colors">
              Privacy
            </Link>
            <span>© 2025</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
