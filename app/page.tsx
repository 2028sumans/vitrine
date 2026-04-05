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
      // fail silently — still show confirmation to user
    } finally {
      setLoading(false);
      setSubmitted(true);
    }
  };

  if (submitted) {
    return (
      <div className="fade-in flex items-center gap-3 py-3 px-5 rounded-full bg-accent-subtle border border-accent/20 text-accent font-medium text-sm w-fit">
        <span className="w-2 h-2 rounded-full bg-accent inline-block" />
        You&apos;re on the list — we&apos;ll be in touch.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-md">
      <div className="flex flex-col sm:flex-row gap-3">
        <label htmlFor={id} className="sr-only">
          Email address
        </label>
        <input
          id={id}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          required
          className="flex-1 px-4 py-3 rounded-full border border-border bg-white text-foreground placeholder-muted/60 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-6 py-3 rounded-full bg-accent text-white text-sm font-semibold whitespace-nowrap hover:bg-accent-light active:scale-95 transition-all duration-150 shadow-sm disabled:opacity-70 disabled:cursor-not-allowed"
        >
          {loading ? "Joining…" : "Join the waitlist"}
        </button>
      </div>
    </form>
  );
}

const steps = [
  {
    number: "01",
    title: "Connect your Pinterest",
    body: "Link your Pinterest account in one click. We read your boards with your permission — nothing else.",
  },
  {
    number: "02",
    title: "We analyze your vibe",
    body: "Our AI reads the aesthetic of your board: the colors, the mood, the specific items. It understands your taste.",
  },
  {
    number: "03",
    title: "Your audience shops it",
    body: "Get a beautiful public storefront with shoppable products that match your board. Share it with your audience. When they buy, everyone wins.",
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Nav */}
      <header className="fade-in px-6 py-5 flex items-center justify-between max-w-5xl mx-auto w-full">
        <span className="text-foreground font-semibold tracking-tight text-lg">
          Vitrine
        </span>
        <span className="text-xs text-muted border border-border rounded-full px-3 py-1">
          Coming soon
        </span>
      </header>

      <main className="flex-1">
        {/* ─── Hero ─── */}
        <section className="px-6 pt-20 pb-28 max-w-5xl mx-auto w-full">
          <div className="max-w-2xl">
            <p className="fade-in-up text-accent text-sm font-medium tracking-widest uppercase mb-6">
              Early access
            </p>
            <h1 className="fade-in-up delay-100 text-5xl sm:text-6xl md:text-7xl font-bold tracking-tighter leading-[1.05] text-foreground mb-6">
              Your Pinterest boards,{" "}
              <span className="text-accent">made shoppable.</span>
            </h1>
            <p className="fade-in-up delay-200 text-lg sm:text-xl text-muted leading-relaxed mb-10 max-w-xl">
              Vitrine analyzes the aesthetic of your Pinterest boards and turns
              them into beautiful storefronts your audience can actually shop.
              Connect your boards, share your taste, we handle the rest.
            </p>
            <div className="fade-in-up delay-300 flex flex-col gap-3">
              <WaitlistForm id="hero-email" />
              <p className="text-xs text-muted pl-1">
                Free to start. No credit card required.
              </p>
            </div>
          </div>
        </section>

        {/* ─── How it works ─── */}
        <section className="px-6 py-24 border-t border-border">
          <div className="max-w-5xl mx-auto">
            <p className="text-accent text-sm font-medium tracking-widest uppercase mb-3">
              How it works
            </p>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-16">
              Three steps to a storefront.
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-10 sm:gap-8">
              {steps.map((step) => (
                <div key={step.number} className="flex flex-col gap-4">
                  <span className="text-4xl font-bold text-accent/30 tracking-tighter leading-none">
                    {step.number}
                  </span>
                  <h3 className="text-xl font-semibold tracking-tight">
                    {step.title}
                  </h3>
                  <p className="text-muted text-sm leading-relaxed">
                    {step.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ─── Who it's for ─── */}
        <section className="px-6 py-24 bg-accent-subtle border-t border-border">
          <div className="max-w-5xl mx-auto">
            <div className="max-w-2xl">
              <p className="text-accent text-sm font-medium tracking-widest uppercase mb-3">
                Who it&apos;s for
              </p>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
                Built for Pinterest creators.
              </h2>
              <p className="text-muted text-lg leading-relaxed">
                If you&apos;ve spent time curating boards that people love —
                home decor, fashion, lifestyle — Vitrine turns that taste into a
                real shopping destination. No brand deals. No complicated setup.
                Just connect your board, share your storefront, and let your
                audience shop the aesthetic you&apos;ve already built.
              </p>
            </div>
          </div>
        </section>

        {/* ─── Business model ─── */}
        <section className="px-6 py-16 border-t border-border">
          <div className="max-w-5xl mx-auto">
            <div className="max-w-xl py-8 px-8 rounded-2xl border border-border bg-white/60">
              <h3 className="text-base font-semibold tracking-tight mb-2">
                How Vitrine works as a business
              </h3>
              <p className="text-muted text-sm leading-relaxed">
                Vitrine is free for creators. We earn a small affiliate
                commission from retailers when your audience makes a purchase
                through your storefront. That&apos;s it — no fees taken from
                you, no ads, no selling your data.
              </p>
            </div>
          </div>
        </section>

        {/* ─── Early access CTA ─── */}
        <section className="px-6 py-28 border-t border-border">
          <div className="max-w-5xl mx-auto">
            <div className="max-w-xl">
              <p className="text-accent text-sm font-medium tracking-widest uppercase mb-3">
                Get early access
              </p>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
                First 100 creators only.
              </h2>
              <p className="text-muted text-lg leading-relaxed mb-10">
                We&apos;re onboarding our first 100 creators. Join the waitlist
                and we&apos;ll reach out personally.
              </p>
              <div className="flex flex-col gap-3">
                <WaitlistForm id="cta-email" />
                <p className="text-xs text-muted pl-1">
                  Free to start. No credit card required.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ─── Footer ─── */}
      <footer className="px-6 py-8 border-t border-border">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-muted">
          <span>© 2025 Vitrine</span>
          <Link
            href="/privacy"
            className="hover:text-foreground transition-colors underline underline-offset-2"
          >
            Privacy Policy
          </Link>
        </div>
      </footer>
    </div>
  );
}
