"use client";

/**
 * Mobile-only hamburger + full-screen menu overlay.
 *
 * Appears only below the `sm` breakpoint. On desktop the component renders
 * nothing at all, so each page's existing horizontal nav is untouched. On
 * mobile it renders:
 *   1. A thin 3-line hamburger button (sits in the page's header slot).
 *   2. When tapped, a fixed cream overlay with the same links stacked in
 *      display italic at a size you can actually read.
 *
 * Each page passes its own `links` array and a `variant` ("cream" or
 * "olive") so the hamburger stays legible against the page's header
 * background. The overlay itself is always cream-bg / olive-type so it
 * reads consistently regardless of the underlying page.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

export interface MenuLink {
  href:  string;
  label: string;
}

type Variant = "cream" | "olive";

// Matches HERO_BG / HERO_TEXT in app/page.tsx.
const OLIVE_CREAM = "#EDE5D0";
const OLIVE_DARK  = "#2A3316";

export function MobileMenu({
  links,
  variant = "cream",
  brand = "SHORTLIST",
}: {
  links:    MenuLink[];
  variant?: Variant;
  brand?:   string;
}) {
  const [open, setOpen] = useState(false);

  // Lock body scroll + bind Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const barColor = variant === "olive" ? OLIVE_CREAM : OLIVE_DARK;

  return (
    <>
      {/* Hamburger button — mobile only. The negative right margin compensates
          for the page header's px-8 so the tap target reaches the edge of the
          viewport without changing the header's padding. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
        className="sm:hidden flex flex-col justify-center items-center gap-[5px] w-9 h-9 -mr-2"
      >
        <span className="block w-5 h-[1.2px] rounded-full" style={{ backgroundColor: barColor }} />
        <span className="block w-5 h-[1.2px] rounded-full" style={{ backgroundColor: barColor }} />
        <span className="block w-5 h-[1.2px] rounded-full" style={{ backgroundColor: barColor }} />
      </button>

      {/* Full-screen overlay — cream bg, olive type. sm:hidden again so if the
          viewport grows past the breakpoint mid-open the overlay tears down. */}
      {open && (
        <div
          className="sm:hidden fixed inset-0 z-[70] flex flex-col"
          style={{ backgroundColor: "#FAFAF5", color: OLIVE_DARK }}
        >
          <div className="px-8 py-2.5 flex items-center justify-between">
            <Link
              href="/"
              onClick={() => setOpen(false)}
              className="font-display font-light text-base tracking-[0.22em] hover:opacity-80 transition-opacity"
              style={{ color: OLIVE_DARK }}
            >
              {brand}
            </Link>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="w-9 h-9 -mr-2 flex items-center justify-center"
              style={{ color: OLIVE_DARK }}
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </div>

          <nav className="flex-1 flex flex-col items-center justify-center gap-9 px-8 pb-24">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="font-display font-light text-4xl hover:opacity-80 transition-opacity"
                style={{ color: OLIVE_DARK }}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </>
  );
}
