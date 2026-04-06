import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Dark-first palette — deep midnight, like Phia
        background:   "#0B1120",
        surface:      "#111827",
        foreground:     "#F5F2EE",
        muted:          "rgba(245,242,238,0.70)",   // readable body text
        "muted-strong": "rgba(245,242,238,0.85)",   // subheadings, key body
        "muted-dim":    "rgba(245,242,238,0.35)",   // footnotes, labels
        border:         "rgba(245,242,238,0.10)",
        "border-mid":   "rgba(245,242,238,0.18)",
        accent:       "#D4C4A8",          // warm parchment — the one accent
        "accent-dim": "rgba(212,196,168,0.15)",
      },
      fontFamily: {
        display: ["var(--font-cormorant)", "Georgia", "serif"],
        sans:    ["var(--font-inter)", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
      },
      letterSpacing: {
        tightest: "-0.05em",
        tighter:  "-0.03em",
        tight:    "-0.01em",
        normal:   "0em",
        wide:     "0.08em",
        wider:    "0.14em",
        widest:   "0.22em",
      },
    },
  },
  plugins: [],
};

export default config;
