"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  delay?: number;
  className?: string;
};

export function Reveal({ children, delay = 0, className = "" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(true);
      return;
    }

    const reveal = (target: Element) => {
      setVisible(true);
      io.unobserve(target);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // Reveal if currently intersecting OR already scrolled past
          // (handles fast scrolls / deep-scroll page loads).
          if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
            reveal(entry.target);
          }
        }
      },
      // Fire when the element crosses ~10% above the viewport bottom. Pair
      // with the 600ms transition (see globals.css .reveal) so the animation
      // actually runs while the user is watching but finishes promptly,
      // before they've scrolled past — avoids the "mid-animation jank" that
      // showed up on slower PCs with the older 1.4s / -15% combo.
      { threshold: 0, rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal ${visible ? "reveal-visible" : ""} ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
