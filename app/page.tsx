"use client";

import { useState } from "react";
import Link from "next/link";

function WaitlistForm({ id }: { id: string }) {
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
      <div className="fade-in flex items-center gap-3 text-sm text-accent font-sans">
        <span className="w-1 h-1 rounded-full bg-accent inline-block" />
        You&apos;re on the list.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm">
      <div className="flex flex-col sm:flex-row gap-2">
        <label htmlFor={id} className="sr-only">Email address</label>
        <input
          id={id}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          required
          className="flex-1 px-4 py-2.5 border border-border bg-white text-foreground placeholder-muted/50 text-sm font-sans focus:outline-none focus:border-accent transition-colors"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-5 py-2.5 bg-foreground text-white text-xs font-sans font-medium tracking-widest uppercase whitespace-nowrap hover:bg-accent transition-colors duration-200 disabled:opacity-60"
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
    body: "Link your account in one click. We read your boards with your permission — and nothing else.",
  },
  {
    num: "II",
    title: "We decode your aesthetic",
    body: "Our AI identifies the exact aesthetic, palette, silhouettes, and mood across your boards.",
  },
  {
    num: "III",
    title: "Shop your own taste",
    body: "Receive a private, curated shopping page — real products chosen by a stylist AI that knows exactly what you love.",
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col bg-background">

      {/* ── Nav ── */}
      <header className="fade-in px-8 py-6 flex items-center justify-between max-w-6xl mx-auto w-full border-b border-border">
        <span className="font-display text-xl font-light tracking-[0.18em] text-foreground">
          VITRINE
        </span>
        <span className="text-[10px] font-sans font-medium tracking-widest uppercase text-muted border border-border px-3 py-1.5">
          Invitation only
        </span>
      </header>

      <main className="flex-1">

        {/* ── Hero ── */}
        <section className="px-8 pt-28 pb-32 max-w-6xl mx-auto w-full">
          <div className="max-w-3xl">

            <p className="fade-in-up text-[10px] font-sans tracking-widest uppercase text-muted mb-10">
              Personal Shopping — Powered by AI
            </p>

            <h1 className="fade-in-up delay-100 font-display font-light text-6xl sm:text-7xl md:text-[88px] leading-[1.0] tracking-tight text-foreground mb-10">
              Your taste,
              <br />
              <em className="not-italic text-accent">made shoppable.</em>
            </h1>

            <p className="fade-in-up delay-200 font-sans text-base sm:text-lg text-muted leading-relaxed mb-14 max-w-xl">
              VITRINE reads your Pinterest boards and builds you a private
              shopping page — curated by an AI stylist that understands exactly
              what you love. No scrolling. No algorithm. Just your taste.
            </p>

            <div className="fade-in-up delay-300 flex flex-col gap-4">
              <WaitlistForm id="hero-email" />
              <p className="text-[11px] font-sans text-muted tracking-wide">
                Free. No card required. First 100 users only.
              </p>
            </div>
          </div>
        </section>

        {/* ── Thin divider with label ── */}
        <div className="max-w-6xl mx-auto px-8">
          <div className="flex items-center gap-6">
            <div className="flex-1 border-t border-border" />
            <span className="text-[9px] font-sans tracking-widest uppercase text-muted/60 whitespace-nowrap">
              How it works
            </span>
            <div className="flex-1 border-t border-border" />
          </div>
        </div>

        {/* ── How it works ── */}
        <section className="px-8 py-28 max-w-6xl mx-auto w-full">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-16 sm:gap-12">
            {steps.map((step) => (
              <div key={step.num} className="flex flex-col gap-5">
                <span className="font-display text-5xl font-light text-border leading-none">
                  {step.num}
                </span>
                <div>
                  <h3 className="font-display text-2xl font-light text-foreground mb-3 leading-snug">
                    {step.title}
                  </h3>
                  <p className="font-sans text-sm text-muted leading-relaxed">
                    {step.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Statement section ── */}
        <section className="border-t border-border">
          <div className="max-w-6xl mx-auto px-8 py-28">
            <div className="max-w-2xl">
              <h2 className="font-display font-light text-4xl sm:text-5xl leading-[1.15] text-foreground mb-8">
                Built for the woman who has spent years pinning things she
                loves — and never found them in one place.
              </h2>
              <p className="font-sans text-sm text-muted leading-relaxed max-w-lg">
                Your boards already say everything. VITRINE just listens — and
                finds the exact pieces that match the aesthetic you&apos;ve
                been quietly, carefully building.
              </p>
            </div>
          </div>
        </section>

        {/* ── What you get ── */}
        <section className="border-t border-border bg-accent-subtle">
          <div className="max-w-6xl mx-auto px-8 py-24">
            <p className="text-[10px] font-sans tracking-widest uppercase text-muted mb-10">
              What you get
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-12">
              {[
                {
                  title: "A real style profile",
                  body: "Named aesthetic, specific color palette, silhouettes, and pieces that define your look.",
                },
                {
                  title: "Curated by AI, not algorithm",
                  body: "A stylist AI selects each product individually — not based on what's trending, but on what fits you.",
                },
                {
                  title: "Real products, real retailers",
                  body: "From ASOS, Nordstrom, Revolve, and more — all filtered by your exact taste and budget.",
                },
              ].map(({ title, body }) => (
                <div key={title} className="border-l border-border pl-6">
                  <h3 className="font-display text-xl font-light text-foreground mb-2">
                    {title}
                  </h3>
                  <p className="font-sans text-sm text-muted leading-relaxed">
                    {body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Transparency ── */}
        <section className="border-t border-border">
          <div className="max-w-6xl mx-auto px-8 py-16">
            <div className="flex items-start gap-4 max-w-lg">
              <span className="text-[10px] font-sans tracking-widest uppercase text-muted mt-1 whitespace-nowrap">
                Note
              </span>
              <p className="font-sans text-sm text-muted leading-relaxed">
                VITRINE is free to use. We earn a small affiliate commission
                from retailers when you purchase — at no extra cost to you.
                We never sell your data.
              </p>
            </div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="border-t border-border">
          <div className="max-w-6xl mx-auto px-8 py-32">
            <div className="max-w-xl">
              <h2 className="font-display font-light text-5xl sm:text-6xl leading-[1.1] text-foreground mb-10">
                Request early access.
              </h2>
              <div className="flex flex-col gap-4">
                <WaitlistForm id="cta-email" />
                <p className="text-[11px] font-sans text-muted tracking-wide">
                  Free. No card required. First 100 users only.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-border px-8 py-8">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="font-display text-sm font-light tracking-[0.15em] text-muted">
            VITRINE
          </span>
          <div className="flex items-center gap-6 text-xs font-sans text-muted">
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
