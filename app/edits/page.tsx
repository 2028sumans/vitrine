/**
 * /edits — index of curated edits.
 *
 * Phia-style: three big hero cards, each clicks into /edits/[slug]. Server-
 * rendered from content/edits.json — no runtime data fetching needed.
 */
import Link from "next/link";
import { listEdits } from "@/lib/edits";
import { MobileMenu } from "../_components/MobileMenu";
import { EditCard } from "../_components/EditCard";

export const metadata = {
  title: "Edits — MUSE",
  description: "Themed, hand-curated product edits from across the MUSE catalog.",
};

export default function EditsIndexPage() {
  const edits = listEdits();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="fade-in fixed top-0 left-0 right-0 z-50 px-8 py-5 flex items-center justify-between bg-background/80 backdrop-blur-sm">
        <Link href="/" className="font-display font-light text-xl tracking-[0.22em] text-foreground">
          MUSE
        </Link>
        <div className="hidden sm:flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase">
          <Link href="/dashboard" className="text-muted hover:text-foreground transition-colors">Get started →</Link>
          <Link href="/shop"   className="text-muted hover:text-foreground transition-colors">Shop</Link>
          <Link href="/brands" className="text-muted hover:text-foreground transition-colors">Brands</Link>
          <Link href="/twin"   className="text-muted hover:text-foreground transition-colors">TwinFinder</Link>
          <Link href="/edit"   className="text-muted hover:text-foreground transition-colors">Your shortlist</Link>
        </div>
        <MobileMenu
          variant="cream"
          links={[
            { href: "/dashboard", label: "Get started →" },
            { href: "/shop",      label: "Shop" },
            { href: "/brands",    label: "Brands" },
            { href: "/twin",      label: "TwinFinder" },
            { href: "/edit",      label: "Your shortlist" },
          ]}
        />
      </header>

      <main className="flex-1 pt-24 pb-24 px-8 max-w-7xl mx-auto w-full">
        {/* Intro */}
        <div className="mb-12">
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-4">Editor&apos;s picks</p>
          <h1 className="font-display font-light text-5xl sm:text-6xl text-foreground leading-tight mb-4">
            Edits
          </h1>
          <p className="font-sans text-base text-muted-strong max-w-2xl leading-relaxed">
            Themed, hand-picked pulls from across the catalog. One idea at a time,
            tightly narrated, shoppable end-to-end.
          </p>
        </div>

        {/* Cards — three tall hero tiles, Phia-style. */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {edits.map((e) => <EditCard key={e.slug} edit={e} />)}
        </div>
      </main>

      <footer className="border-t border-border px-8 py-7">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link href="/" className="font-display font-light tracking-[0.18em] text-sm text-muted hover:text-foreground transition-colors">MUSE</Link>
          <div className="flex items-center gap-8 font-sans text-[10px] tracking-widest uppercase text-muted-dim">
            <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
            <span>© 2025</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

