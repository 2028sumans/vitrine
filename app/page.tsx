"use client";

import Link from "next/link";

// Deep olive hero background + warm cream foreground. Kept as literals here
// (instead of tailwind tokens) so the rest of the app — cream bg + olive text —
// stays unaffected; only the hero flips.
const HERO_BG   = "#333E1D";
const HERO_TEXT = "#EDE5D0";

// ── Data ──────────────────────────────────────────────────────────────────────

const steps = [
  {
    num: "I",
    title: "Show us your eye",
    body: "Share a Pinterest board, describe the vibe in words, upload a few inspiration shots, or take a quick style quiz. However you think about style, we'll translate it.",
  },
  {
    num: "II",
    title: "We read the aesthetic",
    body: "An AI with a fashion editor's eye decodes your palette, silhouettes, mood, and references from everything you share. It looks for specifics, not generic categories.",
  },
  {
    num: "III",
    title: "Shop the shortlist",
    body: "A private, personally curated feed, pulling from sustainable labels, vintage sellers, preloved platforms, and small-batch makers. These are the brands you wouldn't have found on your own.",
  },
];

const features = [
  {
    label: "Four ways to start",
    body: "Pinterest, words, images, or a style quiz. However your taste comes to you.",
  },
  {
    label: "Styled, not searched",
    body: "An AI reads your exact aesthetic with a fashion editor's eye: palette, silhouette, mood, references. No keyword shortcuts.",
  },
  {
    label: "Sustainable, vintage, preloved",
    body: "Hundreds of ethical brands and small-batch makers, alongside vintage stores from around the world and preloved platforms. The shops worth your time, not the ones with the biggest ad budgets.",
  },
  {
    label: "Nothing generic",
    body: "No algorithm-famous pieces, no filler. The feed optimizes for what fits your eye, not for what's trending.",
  },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col">

      {/* ── Nav — fixed, olive-backed, cream text, slim so it clears the hero wordmark. ── */}
      <header
        className="fade-in fixed top-0 left-0 right-0 z-50 px-8 py-2.5 flex items-center justify-between backdrop-blur-sm"
        style={{ backgroundColor: `${HERO_BG}d9` /* ~85% alpha olive */ }}
      >
        <Link
          href="/"
          className="font-display font-light text-base tracking-[0.22em] hover:opacity-80 transition-opacity duration-200"
          style={{ color: HERO_TEXT }}
        >
          MUSE
        </Link>
        <div className="flex items-center gap-8">
          <Link
            href="/brands"
            className="font-sans text-[10px] tracking-widest uppercase hover:opacity-100 transition-opacity duration-200"
            style={{ color: `${HERO_TEXT}b3` /* ~70% alpha */ }}
          >
            Brands
          </Link>
          <Link
            href="/dashboard"
            className="font-sans text-[10px] tracking-widest uppercase hover:opacity-100 transition-opacity duration-200"
            style={{ color: `${HERO_TEXT}b3` }}
          >
            Get started →
          </Link>
        </div>
      </header>

      <main className="flex-1">

        {/* ══ 1. HERO — olive bg, cream text ═══════════════════════════════════ */}
        <section
          className="relative min-h-screen flex flex-col items-center justify-center text-center px-6 pb-24 overflow-hidden"
          style={{ backgroundColor: HERO_BG, color: HERO_TEXT }}
        >

          {/* Radial glow (cream warm glow behind the wordmark) */}
          <div className="absolute inset-0 pointer-events-none"
            style={{ background: "radial-gradient(ellipse 80% 60% at 50% 55%, rgba(237,229,208,0.08) 0%, transparent 70%)" }}
          />

          <div className="relative z-10 max-w-4xl mx-auto">
            <h1
              className="fade-in-up delay-100 font-display font-light text-[clamp(72px,14vw,160px)] leading-[0.9] tracking-[0.1em] mb-10"
              style={{ color: HERO_TEXT }}
            >
              MUSE
            </h1>

            <p
              className="fade-in-up delay-200 font-display font-light italic text-2xl sm:text-3xl mb-5 leading-snug"
              style={{ color: `${HERO_TEXT}99` /* ~60% alpha */ }}
            >
              Ethical fashion, tailored to you.
            </p>

            <p
              className="fade-in-up delay-300 font-sans text-base max-w-md mx-auto leading-relaxed mb-14"
              style={{ color: `${HERO_TEXT}d9` /* ~85% alpha */ }}
            >
              Over 100,000 pieces from vintage stores, eco-friendly labels, and
              small-batch makers. Each one stocks only a few items on its own site.
              We gathered them into a single feed you can search by taste.
            </p>

            <div className="fade-in-up delay-400 flex flex-col sm:flex-row items-center justify-center gap-5">
              <Link
                href="/dashboard"
                className="px-8 py-3 font-sans text-[10px] tracking-widest uppercase hover:opacity-90 transition-opacity duration-200"
                style={{ backgroundColor: HERO_TEXT, color: HERO_BG }}
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
                They&apos;re scattered everywhere.
              </h2>
              <p className="font-sans text-base text-muted-strong leading-relaxed max-w-lg">
                A vintage seller in Tokyo stocks a dozen pieces you&apos;d love.
                So does one in London, one in Stockholm, one in Toronto.
                Every preloved platform and small-batch label has the same story:
                a thin catalog on its own site. Stitching a wardrobe together
                used to mean endless open tabs. Bring the taste you&apos;ve
                spent years building, and we&apos;ll put the ethical labels
                that fit it right in front of you.
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
              MUSE is free to use. When you buy something through one of our
              links, we earn a small affiliate commission at no extra cost to
              you. We never sell your data.
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
