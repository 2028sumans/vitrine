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
        // Primary palette — white background, dark olive text.
        // Token names preserved for backward compat (navy/cream no longer
        // literal — navy tokens now carry the olive values).
        background:     "#FFFFFF",
        foreground:     "#3A4A24",          // dark olive green
        muted:          "rgba(58,74,36,0.60)",
        "muted-strong": "rgba(58,74,36,0.85)",
        "muted-dim":    "rgba(58,74,36,0.30)",
        border:         "rgba(58,74,36,0.15)",
        "border-mid":   "rgba(58,74,36,0.28)",
        accent:         "#6B7F3E",          // brighter olive for highlights

        // Legacy "cream/navy" section tokens — now aliases for the same palette.
        // Safe to keep since JSX still references them; values just changed.
        cream:             "#FFFFFF",
        navy:              "#3A4A24",
        "navy-muted":      "rgba(58,74,36,0.60)",
        "navy-strong":     "rgba(58,74,36,0.85)",
        "navy-dim":        "rgba(58,74,36,0.30)",
        "navy-border":     "rgba(58,74,36,0.12)",
        "navy-border-mid": "rgba(58,74,36,0.22)",
      },
      boxShadow: {
        // Soft olive-tinted drop shadow so product cards float on the new
        // white background instead of blending in.
        card:       "0 4px 14px -4px rgba(58,74,36,0.18)",
        "card-hover": "0 8px 24px -4px rgba(58,74,36,0.26)",
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
