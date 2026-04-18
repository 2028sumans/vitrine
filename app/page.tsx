"use client";

import Link from "next/link";

// ── Data ──────────────────────────────────────────────────────────────────────

const steps = [
  {
    num: "I",
    title: "Show us your eye",
    body: "Share a Pinterest board, describe the vibe in words, upload a few inspiration shots, or take a quick style quiz. Whatever way you think about clothes, we translate it.",
  },
  {
    num: "II",
    title: "We read the aesthetic",
    body: "An AI with a fashion editor's eye decodes palette, silhouettes, mood, and references across your inputs. Specifics, not generic categories.",
  },
  {
    num: "III",
    title: "Shop the shortlist",
    body: "A private, personally-curated feed pulling from sustainable labels, vintage sellers, preloved platforms, and small-batch makers — the brands you wouldn't find on your own.",
  },
];

const features = [
  {
    label: "Four ways to start",
    body: "Pinterest, words, images, or a style quiz. However the taste comes to you.",
  },
  {
    label: "Styled, not searched",
    body: "An AI reads your exact aesthetic with a fashion editor's eye — palette, silhouette, mood, references. No keyword shortcuts.",
  },
  {
    label: "Sustainable, vintage, preloved",
    body: "Hundreds of ethical brands and small-batch makers alongside vintage stores from around the world and preloved platforms. The shops worth your time, rather than the ones with the biggest ad budgets.",
  },
  {
    label: "Nothing generic",
    body: "No algorithm-famous pieces, no filler. The feed optimizes for what fits your eye, not what's trending.",
  },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col">

      {/* ── Nav ── */}
      <header className="fade-in fixed top-0 left-0 right-0 z-50 px-8 py-5 flex items-center justify-between">
        <span className="font-display font-light text-xl tracking-[0.22em] text-foreground">
          MUSE
        </span>
        <div className="flex items-center gap-8">
          <Link
            href="/brands"
            className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors duration-200"
          >
            Brands
          </Link>
          <Link
            href="/dashboard"
            className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors duration-200"
          >
            Get started →
          </Link>
        </div>
      </header>

      <main className="flex-1">

        {/* ══ 1. HERO ══════════════════════════════════════════════════════════ */}
        <section className="relative min-h-screen flex flex-col items-center justify-center text-center px-6 pb-24 overflow-hidden bg-background">

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
            <h1 className="fade-in-up delay-100 font-display font-light text-[clamp(72px,14vw,160px)] leading-[0.9] tracking-[0.1em] text-foreground mb-10">
              MUSE
            </h1>

            <p className="fade-in-up delay-200 font-display font-light italic text-2xl sm:text-3xl text-foreground/60 mb-5 leading-snug">
              Ethical fashion, tailored to you.
            </p>

            <p className="fade-in-up delay-300 font-sans text-base text-muted-strong max-w-md mx-auto leading-relaxed mb-14">
              100,000+ pieces from sustainable labels, vintage stores around the world,
              preloved platforms, and ethical small-batch makers. Each one carries
              only a handful of things, each on its own site. We pulled them together
              into one feed, searchable by your taste.
            </p>

            <div className="fade-in-up delay-400 flex flex-col sm:flex-row items-center justify-center gap-5">
              <Link
                href="/dashboard"
                className="px-8 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors duration-200"
              >
                Get started →
              </Link>
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
                The best brands are tiny.
                And scattered everywhere.
              </h2>
              <p className="font-sans text-base text-muted-strong leading-relaxed max-w-lg">
                Each vintage seller — Tokyo, London, Stockholm, Toronto —
                each preloved platform, each small-batch label stocks a
                dozen pieces you&apos;d love, on its own site.
                Stitching a wardrobe from them used to mean endless tabs.
                Bring the taste you&apos;ve already spent years building;
                we put the ethical labels that fit it in front of you.
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
              MUSE is free. We earn a small affiliate commission when you
              purchase through your page, at no cost to you. We never sell your
              data.
            </p>
          </div>
        </div>
      </main>

      {/* ══ FOOTER ══════════════════════════════════════════════════════════ */}
      <footer className="bg-background border-t border-border px-8 py-7">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="font-display font-light tracking-[0.18em] text-sm text-muted">
            MUSE
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
