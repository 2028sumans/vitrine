"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { Reveal } from "./_components/Reveal";
import { MobileMenu } from "./_components/MobileMenu";
import { EditCard } from "./_components/EditCard";
import { listFeaturedEdits, type Edit } from "@/lib/edits";

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
// the copy doesn't drift into generic brand-PR territory. Images are pulled
// from each brand's own Shopify CDN — same pattern as /brands.
// Each card links through to /shop?brand=X, the identical route you land on
// when you click a brand tile on /brands, so the grid/scroll toggle, pagination,
// and session signals all work out of the box.

type Spotlight = {
  brand:    string;
  href:     string;
  image:    string;
  kicker:   string;
  tagline:  string; // one editorial line, runs under the card
};

const SPOTLIGHTS: ReadonlyArray<Spotlight> = [
  {
    brand:   "St. Agni",
    href:    "/shop?brand=St.%20Agni",
    image:   "https://cdn.shopify.com/s/files/1/1139/4362/files/20250723_StAgni_S26_Ecom_SH_130_BAMBI_5649copy.jpg?v=1768956513",
    kicker:  "Inside",
    tagline: "Byron Bay slow fashion. LWG-certified leather, linen cut for a long Australian summer, drops small enough to still feel personal.",
  },
  {
    brand:   "Johnstons Of Elgin",
    href:    "/shop?brand=Johnstons%20Of%20Elgin",
    image:   "https://cdn.shopify.com/s/files/1/0725/7427/1766/files/WR000024_SB3022_VICUNA_flat_lay.jpg?v=1770368221",
    kicker:  "Since 1797",
    tagline: "Scottish cashmere, still mill-spun in Hawick after 228 years. Fleece traced to named farms, woven and finished on the Elgin looms their grandparents ran.",
  },
  {
    brand:   "Tove",
    href:    "/shop?brand=Tove",
    image:   "https://cdn.shopify.com/s/files/1/0155/8868/7920/files/emily_shearling_tove.jpg?v=1710886755",
    kicker:  "Inside",
    tagline: "A small London studio run by Camille Perry and Holly Wright. Silks, cottons, a handful of pieces a season — each one cut to outlast the trend that launched it.",
  },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HomePage() {
  // Rotate the three homepage cards on every page load. SSR and the first
  // client render both show the first three in authored order so hydration
  // matches; useEffect reshuffles after mount. The edits section sits below
  // the fold (after the hero and "Three steps"), so the swap happens before
  // the user ever sees it — no visible flicker on scroll down.
  const allEdits = listFeaturedEdits();
  const [featuredEdits, setFeaturedEdits] = useState<Edit[]>(() => allEdits.slice(0, 3));
  useEffect(() => {
    const shuffled = [...allEdits].sort(() => Math.random() - 0.5);
    setFeaturedEdits(shuffled.slice(0, 3));
    // allEdits is derived from static JSON, stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auth — drives the Sign out pill at the right edge of the nav. `status`
  // goes "loading" → "authenticated" | "unauthenticated" so we wait for a
  // resolved state before deciding what to render (prevents a flash of the
  // signed-out state for a signed-in user on first paint).
  const { status: authStatus } = useSession();
  const isAuthed = authStatus === "authenticated";

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
            href="/twin"
            className="font-sans text-[10px] tracking-widest uppercase hover:opacity-100 transition-opacity duration-200"
            style={{ color: `${HERO_TEXT}b3` }}
          >
            TwinFinder
          </Link>
          <Link
            href="/edit"
            className="font-sans text-[10px] tracking-widest uppercase hover:opacity-100 transition-opacity duration-200"
            style={{ color: `${HERO_TEXT}b3` }}
          >
            Your shortlist
          </Link>

          {/* Auth pill — swaps between Sign in (signed-out) and Sign out
              (signed-in). Bordered pill style so it reads as an action,
              not another nav link. We render NOTHING while `authStatus`
              is still "loading" — avoids flashing the wrong label for
              ~100 ms after first paint on signed-in users. */}
          {authStatus === "authenticated" && (
            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="font-sans text-[10px] tracking-widest uppercase px-3 py-1.5 border hover:bg-[rgba(237,229,208,0.1)] transition-colors duration-200"
              style={{
                color:       HERO_TEXT,
                borderColor: `${HERO_TEXT}66` /* ~40% alpha */,
              }}
            >
              Sign out
            </button>
          )}
          {authStatus === "unauthenticated" && (
            <Link
              href="/login"
              className="font-sans text-[10px] tracking-widest uppercase px-3 py-1.5 border hover:bg-[rgba(237,229,208,0.1)] transition-colors duration-200"
              style={{
                color:       HERO_TEXT,
                borderColor: `${HERO_TEXT}66` /* ~40% alpha */,
              }}
            >
              Sign in
            </Link>
          )}
        </div>

        {/* Mobile hamburger — olive-bar version so it reads against the
            olive header background. Renders nothing on sm+. */}
        <MobileMenu
          variant="olive"
          links={[
            { href: "/shop",      label: "Shop" },
            { href: "/brands",    label: "Brands" },
            { href: "/twin",      label: "TwinFinder" },
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
              {/* "Tailor to your taste" used to live as a separate page —
                  it's now an inline search bar on every /shop category and
                  on Shop all, so a single CTA into /shop covers both. */}
              <Link
                href="/shop"
                className="px-8 py-3 font-sans text-[10px] tracking-widest uppercase hover:opacity-90 transition-opacity duration-200 min-w-[220px] text-center"
                style={{ backgroundColor: HERO_TEXT, color: HERO_BG }}
              >
                Start shopping →
              </Link>
              <Link
                href="/shop?all=1"
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

        {/* ══ 3. EDITOR'S PICKS — CREAM ══════════════════════════════════════
            Phia-inspired: three tall hero cards pointing at curated edits.
            Sits after "Three steps" — you understand the pitch first, then
            see something shoppable. */}
        {featuredEdits.length > 0 && (
          <section className="bg-cream px-8 pt-4 pb-28 max-w-full">
            <div className="max-w-6xl mx-auto">
              <Reveal>
                <div className="flex items-end justify-between flex-wrap gap-4 mb-12">
                  <div>
                    <p className="font-sans text-[9px] tracking-widest uppercase text-navy-muted mb-4">
                      Editor&apos;s picks
                    </p>
                    <h2 className="font-display font-light text-5xl sm:text-6xl text-navy leading-tight">
                      The edits.
                    </h2>
                  </div>
                  <Link
                    href="/edits"
                    className="font-sans text-[10px] tracking-widest uppercase text-navy-strong hover:text-accent transition-colors"
                  >
                    View all →
                  </Link>
                </div>
              </Reveal>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                {featuredEdits.slice(0, 3).map((e, i) => (
                  <Reveal key={e.slug} delay={i * 100}>
                    <EditCard edit={e} />
                  </Reveal>
                ))}
              </div>
            </div>
          </section>
        )}

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
            Three equal-sized editorial cards, borrowing Phia's "Editor's
            picks" shape: full-bleed 4:5 image, italic kicker + serif brand
            name overlaid at the bottom-left, "Start exploring →" underlined.
            A one-line editor's note sits below each card with the ethics
            angle. Each card links to /shop?brand=X — exactly the same route
            as clicking a brand on /brands, so the grid/scroll toggle and
            pagination come along for free. */}
        <section className="bg-cream px-8 py-28">
          <div className="max-w-6xl mx-auto">
            <Reveal>
              <div className="mb-14">
                <p className="font-sans text-[10px] tracking-widest uppercase text-navy-muted mb-3">
                  This month
                </p>
                <h2 className="font-display font-light italic text-5xl sm:text-6xl text-navy leading-tight">
                  Brand spotlight
                </h2>
              </div>
            </Reveal>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-7 md:gap-6">
              {SPOTLIGHTS.map((s, i) => (
                <Reveal key={s.brand} delay={i * 120}>
                  <div className="flex flex-col h-full">
                    <Link
                      href={s.href}
                      className="group relative block aspect-[4/5] w-full overflow-hidden bg-[rgba(42,51,22,0.04)] shadow-card hover:shadow-card-hover transition-shadow duration-300"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={s.image}
                        alt={s.brand}
                        loading="lazy"
                        decoding="async"
                        className="absolute inset-0 h-full w-full object-cover object-center group-hover:scale-[1.03] transition-transform duration-700"
                      />
                      {/* Gradient so the overlay text reads against any image.
                          Kept strong at the bottom, transparent up top. */}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent pointer-events-none" />

                      <div className="absolute bottom-0 left-0 right-0 p-6 sm:p-7">
                        <p className="font-display font-light italic text-white/80 text-base mb-1">
                          {s.kicker}
                        </p>
                        <h3 className="font-display font-light text-white text-3xl sm:text-[34px] leading-[1.05] tracking-tight mb-4 drop-shadow-sm break-words">
                          {s.brand}
                        </h3>
                        <span className="font-sans text-[10px] tracking-widest uppercase text-white border-b border-white/60 pb-px">
                          Start exploring →
                        </span>
                      </div>
                    </Link>

                    {/* Editor's note — one line, runs under the card. Kept
                        plain body text so the image carries the visual weight. */}
                    <p className="font-sans text-sm text-navy-strong leading-relaxed mt-5">
                      {s.tagline}
                    </p>
                  </div>
                </Reveal>
              ))}
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
