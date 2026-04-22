"use client";

import Link from "next/link";
import { Reveal } from "./_components/Reveal";
import { MobileMenu } from "./_components/MobileMenu";

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
    body: "Share a Pinterest board, describe the vibe in words, or upload a few inspiration shots. However you think about style, we'll translate it.",
  },
  {
    num: "II",
    title: "We read the aesthetic",
    body: "We read your palette, silhouettes, mood, and references with a fashion editor's eye. Specifics over generic categories.",
  },
  {
    num: "III",
    title: "Shop the edit",
    body: "A private, personally curated feed, pulling from sustainable labels, vintage sellers, preloved platforms, and small-batch makers. These are the brands you wouldn't have found on your own.",
  },
];

// ── Brand spotlight ───────────────────────────────────────────────────────────
// Rotates monthly in spirit; the actual content is hand-edited each time so
// the copy doesn't drift into generic brand-PR territory. Image is a hero
// from St. Agni's own lookbook — borrowed through their Shopify CDN the same
// way /brands surfaces brand cards.

const SPOTLIGHT = {
  brand: "St. Agni",
  href:  "/shop?brand=St.%20Agni",
  image: "https://cdn.shopify.com/s/files/1/1139/4362/files/20250723_StAgni_S26_Ecom_SH_130_BAMBI_5649copy.jpg?v=1768956513",
  kicker: "Inside",
  paragraphs: [
    "Lara and Matthew Fells started St. Agni out of Byron Bay a decade ago, and the brand still feels run from there — mid-weight cream linen, leather slides cut the shape of a ballet flat, a wardrobe that reads like a long summer on the Northern Rivers.",
    "The ethics are the quiet kind. Leather comes from Leather Working Group-certified tanneries in Portugal and Italy rather than the cheapest hide on the market. Ready-to-wear is mostly linen, organic cotton, and silk, stitched in a handful of factories the brand has used for years and names on the site. Drops are small, a few times a year — the opposite of a fast-fashion calendar.",
    "Nothing about St. Agni is trying to be new. The cream trousers from 2019 are still in production. That's the point.",
  ],
};

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
        {/* Desktop links — hidden on mobile, replaced by the hamburger below. */}
        <div className="hidden sm:flex items-center gap-8">
          <Link
            href="/dashboard"
            className="font-sans text-[10px] tracking-widest uppercase hover:opacity-100 transition-opacity duration-200"
            style={{ color: `${HERO_TEXT}b3` /* ~70% alpha */ }}
          >
            Get started →
          </Link>
          <Link
            href="/shop"
            className="font-sans text-[10px] tracking-widest uppercase hover:opacity-100 transition-opacity duration-200"
            style={{ color: `${HERO_TEXT}b3` }}
          >
            Shop
          </Link>
          <Link
            href="/brands"
            className="font-sans text-[10px] tracking-widest uppercase hover:opacity-100 transition-opacity duration-200"
            style={{ color: `${HERO_TEXT}b3` }}
          >
            Brands
          </Link>
          <Link
            href="/edit"
            className="font-sans text-[10px] tracking-widest uppercase hover:opacity-100 transition-opacity duration-200"
            style={{ color: `${HERO_TEXT}b3` }}
          >
            Your shortlist
          </Link>
        </div>

        {/* Mobile hamburger — olive-bar version so it reads against the
            olive header background. Renders nothing on sm+. */}
        <MobileMenu
          variant="olive"
          links={[
            { href: "/dashboard", label: "Get started →" },
            { href: "/shop",      label: "Shop" },
            { href: "/brands",    label: "Brands" },
            { href: "/edit",      label: "Your shortlist" },
          ]}
        />
      </header>

      <main className="flex-1">

        {/* ══ 1. HERO — olive bg, cream text ═══════════════════════════════════
            Symmetric pt/pb so content is actually centered in the viewport
            (previously pb-only biased everything upward, crowding the fixed
            header). A slight extra top nudge keeps the big MUSE wordmark
            clear of the nav at every viewport height. */}
        <section
          className="relative min-h-screen flex flex-col items-center justify-center text-center px-6 pt-32 pb-24 overflow-hidden"
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

            <div className="fade-in-up delay-400 flex flex-col items-center justify-center gap-3">
              <Link
                href="/dashboard"
                className="px-8 py-3 font-sans text-[10px] tracking-widest uppercase hover:opacity-90 transition-opacity duration-200 min-w-[220px] text-center"
                style={{ backgroundColor: HERO_TEXT, color: HERO_BG }}
              >
                Tailor to your taste →
              </Link>
              <Link
                href="/shop"
                className="px-8 py-3 font-sans text-[10px] tracking-widest uppercase border hover:bg-[rgba(237,229,208,0.1)] transition-colors duration-200 min-w-[220px] text-center"
                style={{ borderColor: HERO_TEXT, color: HERO_TEXT }}
              >
                Shop all →
              </Link>
              <Link
                href="/brands"
                className="px-8 py-3 font-sans text-[10px] tracking-widest uppercase border hover:bg-[rgba(237,229,208,0.1)] transition-colors duration-200 min-w-[220px] text-center"
                style={{ borderColor: HERO_TEXT, color: HERO_TEXT }}
              >
                Brands →
              </Link>
            </div>
          </div>
        </section>

        {/* ══ 2. HOW IT WORKS — CREAM ═════════════════════════════════════════ */}
        <section className="bg-cream px-8 py-28 max-w-full">
          <div className="max-w-6xl mx-auto">
            <Reveal>
              <div className="mb-20">
                <h2 className="font-display font-light text-5xl sm:text-6xl text-navy leading-tight">
                  Three steps.
                </h2>
              </div>
            </Reveal>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-12 sm:gap-8">
              {steps.map((step, i) => (
                <Reveal key={step.num} delay={i * 120}>
                  <p className="font-display font-light text-6xl text-navy/40 mb-6 leading-none select-none">
                    {step.num}
                  </p>
                  <h3 className="font-display font-light text-3xl text-navy mb-3 leading-snug">
                    {step.title}
                  </h3>
                  <p className="font-sans text-base text-navy-strong leading-relaxed">
                    {step.body}
                  </p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ══ 3. STATEMENT — NAVY ═════════════════════════════════════════════ */}
        <section className="bg-background px-8 py-32">
          <div className="max-w-6xl mx-auto">
            <Reveal>
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
            </Reveal>
          </div>
        </section>

        {/* ══ 4. BRAND SPOTLIGHT — CREAM ══════════════════════════════════════
            Replaces the old "What you get" features grid. One editorial
            card (large image + serif kicker + brand name) on the left, a
            hand-written brand note on the right. Phia's "Editor's picks"
            card shape borrowed for the image; everything else is MUSE
            typography. */}
        <section className="bg-cream px-8 py-28">
          <div className="max-w-6xl mx-auto">
            <Reveal>
              <div className="mb-14 flex items-baseline gap-4">
                <p className="font-sans text-[9px] tracking-widest uppercase text-navy-muted">
                  Brand spotlight
                </p>
                <p className="font-display font-light italic text-lg text-navy/70">
                  this month
                </p>
              </div>
            </Reveal>

            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-10 lg:gap-16 items-start">

              {/* Card — full-bleed image with serif overlay at bottom-left,
                  "Start exploring →" underneath. Slight hover-zoom on the
                  image, matching /brands and /shop tiles. */}
              <Reveal>
                <Link
                  href={SPOTLIGHT.href}
                  className="group relative block aspect-[4/5] w-full overflow-hidden bg-[rgba(42,51,22,0.04)] shadow-card hover:shadow-card-hover transition-shadow duration-300"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={SPOTLIGHT.image}
                    alt={SPOTLIGHT.brand}
                    loading="eager"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover object-center group-hover:scale-[1.03] transition-transform duration-700"
                  />
                  {/* Darkening gradient so the overlay text reads against any
                      image. Kept strong at the bottom, transparent up top. */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent pointer-events-none" />

                  <div className="absolute bottom-0 left-0 right-0 p-8 sm:p-10">
                    <p className="font-display font-light italic text-white/80 text-lg mb-1">
                      {SPOTLIGHT.kicker}
                    </p>
                    <h3 className="font-display font-light text-white text-4xl sm:text-5xl leading-[1.05] tracking-tight mb-5 drop-shadow-sm">
                      {SPOTLIGHT.brand}
                    </h3>
                    <span className="font-sans text-[10px] tracking-widest uppercase text-white border-b border-white/60 pb-px">
                      Start exploring →
                    </span>
                  </div>
                </Link>
              </Reveal>

              {/* Story — plain editorial body text so the card carries the
                  image weight. */}
              <Reveal delay={120}>
                <div className="lg:pt-4">
                  <p className="font-sans text-[9px] tracking-widest uppercase text-navy-muted mb-5">
                    Why we&apos;re featuring them
                  </p>
                  <h4 className="font-display font-light text-3xl sm:text-4xl text-navy leading-tight mb-6">
                    Slow fashion out of Byron Bay.
                  </h4>
                  {SPOTLIGHT.paragraphs.map((p, i) => (
                    <p
                      key={i}
                      className="font-sans text-base text-navy-strong leading-relaxed mb-5 last:mb-0"
                    >
                      {p}
                    </p>
                  ))}

                  <Link
                    href={SPOTLIGHT.href}
                    className="mt-8 inline-block px-7 py-3 border border-navy text-navy font-sans text-[10px] tracking-widest uppercase hover:bg-navy hover:text-cream transition-colors duration-200"
                  >
                    Shop {SPOTLIGHT.brand} →
                  </Link>
                </div>
              </Reveal>
            </div>
          </div>
        </section>
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
