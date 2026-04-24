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
import { useSession, signOut } from "next-auth/react";
import { createPortal } from "react-dom";

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
  brand = "MUSE",
}: {
  links:    MenuLink[];
  variant?: Variant;
  brand?:   string;
}) {
  const [open, setOpen] = useState(false);
  // Only render the portal after mount — server-render and first client
  // render would both fail on `document.body` otherwise.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Auth state — drives the Sign in / Sign out row at the bottom of the
  // overlay. "loading" is kept as its own case so neither label flashes
  // before the session resolves.
  const { status: authStatus } = useSession();

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

  // Overlay is rendered via a portal to document.body so it escapes any
  // ancestor that establishes a containing block for `position: fixed`.
  // The page header uses `backdrop-blur-sm` (a `backdrop-filter` property),
  // which does exactly that — without the portal the overlay was being
  // clipped to the header's bounds and the rest of the page bled through.
  const overlay = (
    <div
      className="sm:hidden fixed inset-0 z-[9999] flex flex-col overflow-y-auto"
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

        {/* Auth row — Sign in (signed-out) OR Sign out (signed-in).
            Bordered, uppercase, visually distinct from the display-italic
            nav links so it reads as an action. We intentionally render
            nothing during the `loading` state to avoid a split-second
            flicker of the wrong label on first open. */}
        {authStatus === "authenticated" && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              signOut({ callbackUrl: "/" });
            }}
            className="mt-4 px-6 py-3 font-sans text-[10px] tracking-widest uppercase border hover:bg-[rgba(42,51,22,0.06)] transition-colors"
            style={{ color: OLIVE_DARK, borderColor: `${OLIVE_DARK}4d` }}
          >
            Sign out
          </button>
        )}
        {authStatus === "unauthenticated" && (
          <Link
            href="/login"
            onClick={() => setOpen(false)}
            className="mt-4 px-6 py-3 font-sans text-[10px] tracking-widest uppercase border hover:bg-[rgba(42,51,22,0.06)] transition-colors"
            style={{ color: OLIVE_DARK, borderColor: `${OLIVE_DARK}4d` }}
          >
            Sign in
          </Link>
        )}
      </nav>
    </div>
  );

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

      {/* Overlay is portaled to document.body — see comment on `overlay`. */}
      {open && mounted && createPortal(overlay, document.body)}
    </>
  );
}
