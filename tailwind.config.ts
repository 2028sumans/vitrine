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
        // Primary palette — soft off-white background, deep olive text.
        // Token names preserved for backward compat.
        background:     "#FAFAF5",          // warm off-white
        foreground:     "#2A3316",          // deeper olive for stronger contrast
        muted:          "rgba(42,51,22,0.60)",
        "muted-strong": "rgba(42,51,22,0.85)",
        "muted-dim":    "rgba(42,51,22,0.30)",
        border:         "rgba(42,51,22,0.15)",
        "border-mid":   "rgba(42,51,22,0.28)",
        accent:         "#5E7236",

        cream:             "#FAFAF5",
        navy:              "#2A3316",
        "navy-muted":      "rgba(42,51,22,0.60)",
        "navy-strong":     "rgba(42,51,22,0.85)",
        "navy-dim":        "rgba(42,51,22,0.30)",
        "navy-border":     "rgba(42,51,22,0.12)",
        "navy-border-mid": "rgba(42,51,22,0.22)",
      },
      boxShadow: {
        card:       "0 4px 14px -4px rgba(42,51,22,0.20)",
        "card-hover": "0 8px 24px -4px rgba(42,51,22,0.28)",
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
