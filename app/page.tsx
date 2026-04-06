"use client";

import { useState } from "react";
import Link from "next/link";

function WaitlistForm({ id, light = false }: { id: string; light?: boolean }) {
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
      <p className="fade-in font-sans text-sm text-accent tracking-wide">
        You&apos;re on the list.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm">
      <label htmlFor={id} className="sr-only">Email address</label>
      <div className="flex">
        <input
          id={id}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          required
          className={`flex-1 px-4 py-3 text-sm font-sans placeholder-foreground/25 focus:outline-none transition-colors ${
            light
              ? "bg-white/8 border border-border text-foreground focus:border-border-mid"
              : "bg-white/6 border border-border text-foreground focus:border-border-mid"
          }`}
        />
        <button
          type="submit"
          disabled={loading}
          className="px-5 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase font-medium whitespace-nowrap hover:bg-accent hover:text-background transition-colors duration-200 disabled:opacity-50"
        >
          {loading ? "…" : "Request access"}
        </button>
      </div>
    </form>
  );
}

const steps = [
  {
    num: "I",
    title: "Connect your Pinterest",
    body: "Link your account in one tap. We read your boards with your permission — and nothing else.",
  },
  {
    num: "II",
    title: "We decode your aesthetic",
    body: "Our AI identifies the exact aesthetic, palette, silhouettes, and mood across your boards — with a fashion stylist's eye.",
  },
  {
    num: "III",
    title: "Shop your own taste",
    body: "Receive a private, personally curated page — real products from real retailers, edited to match exactly what you love.",
  },
];

const features = [
  {
    label: "Named aesthetic",
    body: "Not just 'minimalist'. Think quiet luxury, coastal grandmother, dark academia, clean girl — a real style identity.",
  },
  {
    label: "Your color palette",
    body: "Dusty sage. Warm ivory. Slate blue. Specific colors, not generic descriptions.",
  },
  {
    label: "Curated by AI",
    body: "A stylist AI selects each piece individually — filtered by fit, color coherence, and what you actively avoid.",
  },
  {
    label: "Real retailers",
    body: "ASOS, Nordstrom, Revolve, Bloomingdale's and more — filtered to match your exact budget.",
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">

      {/* ── Nav ── */}
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

        {/* ── Hero ── */}
        <section className="relative min-h-screen flex flex-col items-center justify-center text-center px-6 overflow-hidden">

          {/* Background atmosphere — radial glow */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse 80% 60% at 50% 55%, rgba(212,196,168,0.06) 0%, transparent 70%)",
            }}
          />

          {/* Subtle grid lines — editorial feel */}
          <div
            className="absolute inset-0 pointer-events-none opacity-[0.03]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(245,242,238,1) 1px, transparent 1px), linear-gradient(90deg, rgba(245,242,238,1) 1px, transparent 1px)",
              backgroundSize: "80px 80px",
            }}
          />

          <div className="relative z-10 max-w-4xl mx-auto">
            <p className="fade-in font-sans text-[10px] tracking-widest uppercase text-muted mb-12">
              Personal Shopping — AI-Powered
            </p>

            {/* Wordmark / hero */}
            <h1 className="fade-in-up delay-100 font-display font-light text-[clamp(72px,14vw,160px)] leading-[0.9] tracking-[0.1em] text-foreground mb-10">
              VITRINE
            </h1>

            <p className="fade-in-up delay-200 font-display font-light italic text-2xl sm:text-3xl text-foreground/70 mb-4 leading-snug">
              Your taste, made shoppable.
            </p>

            <p className="fade-in-up delay-300 font-sans text-base text-muted-strong max-w-md mx-auto leading-relaxed mb-14">
              VITRINE reads your Pinterest boards and builds you a private
              shopping page — curated by an AI stylist that understands exactly
              what you love.
            </p>

            <div className="fade-in-up delay-400 flex flex-col items-center gap-4">
              <WaitlistForm id="hero-email" />
              <p className="font-sans text-[11px] text-muted/60 tracking-wide">
                Free. First 100 users only.
              </p>
            </div>
          </div>

          {/* Scroll hint */}
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 fade-in delay-600 flex flex-col items-center gap-2 opacity-30">
            <div className="w-px h-12 bg-foreground/40" />
          </div>
        </section>

        {/* ── Divider ── */}
        <div className="border-t border-border" />

        {/* ── How it works ── */}
        <section className="px-8 py-28 max-w-6xl mx-auto">
          <div className="mb-20">
            <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">
              How it works
            </p>
            <h2 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight">
              Three steps.
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-12 sm:gap-8">
            {steps.map((step) => (
              <div key={step.num} className="group">
                <p className="font-display font-light text-6xl text-foreground/10 mb-6 leading-none select-none">
                  {step.num}
                </p>
                <h3 className="font-display font-light text-2xl text-foreground mb-3 leading-snug">
                  {step.title}
                </h3>
                <p className="font-sans text-base text-muted-strong leading-relaxed">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Statement ── */}
        <section className="border-t border-border">
          <div className="max-w-6xl mx-auto px-8 py-32">
            <div className="max-w-3xl">
              <h2 className="font-display font-light text-4xl sm:text-5xl md:text-6xl leading-[1.1] text-foreground mb-8">
                Built for the woman who has been pinning for years — and never
                found all of it in one place.
              </h2>
              <p className="font-sans text-base text-muted-strong leading-relaxed max-w-lg">
                Your boards already say everything. VITRINE listens — and finds
                the exact pieces that match the aesthetic you&apos;ve been
                quietly, carefully building.
              </p>
            </div>
          </div>
        </section>

        {/* ── Features ── */}
        <section className="border-t border-border">
          <div className="max-w-6xl mx-auto px-8 py-24">
            <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-14">
              What you get
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-16 gap-y-10">
              {features.map(({ label, body }) => (
                <div key={label} className="flex gap-6 items-start">
                  <div className="w-px h-10 bg-border-mid flex-shrink-0 mt-0.5" />
                  <div>
                    <h3 className="font-display font-light text-xl text-foreground mb-2">
                      {label}
                    </h3>
                    <p className="font-sans text-base text-muted-strong leading-relaxed">
                      {body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="border-t border-border">
          <div className="max-w-6xl mx-auto px-8 py-36">
            <h2 className="font-display font-light text-5xl sm:text-7xl text-foreground leading-[1.05] mb-12">
              Request early access.
            </h2>
            <div className="flex flex-col gap-4">
              <WaitlistForm id="cta-email" />
              <p className="font-sans text-[11px] text-muted/60 tracking-wide">
                Free. First 100 users only.
              </p>
            </div>
          </div>
        </section>

        {/* ── Transparency ── */}
        <div className="border-t border-border">
          <div className="max-w-6xl mx-auto px-8 py-10 flex items-start gap-8">
            <p className="font-sans text-[9px] tracking-widest uppercase text-muted/50 mt-0.5 whitespace-nowrap">
              Note
            </p>
            <p className="font-sans text-xs text-muted-dim leading-relaxed max-w-md">
              VITRINE is free. We earn a small affiliate commission when you
              purchase through your page — at no cost to you. We never sell your
              data.
            </p>
          </div>
        </div>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-border px-8 py-7">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="font-display font-light tracking-[0.18em] text-sm text-muted/50">
            VITRINE
          </span>
          <div className="flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase text-muted/40">
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
