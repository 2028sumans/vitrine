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
        // Navy sections (dark bg, cream text)
        background:     "#0C1221",
        foreground:     "#F0E8D8",          // warm cream
        muted:          "rgba(240,232,216,0.60)",
        "muted-strong": "rgba(240,232,216,0.85)",
        "muted-dim":    "rgba(240,232,216,0.30)",
        border:         "rgba(240,232,216,0.10)",
        "border-mid":   "rgba(240,232,216,0.20)",
        accent:         "#C9B99A",

        // Cream sections (light bg, navy text)
        cream:             "#F0E8D8",       // the cream colour itself
        navy:              "#0C1221",       // navy used as text on cream
        "navy-muted":      "rgba(12,18,33,0.55)",
        "navy-strong":     "rgba(12,18,33,0.82)",
        "navy-dim":        "rgba(12,18,33,0.28)",
        "navy-border":     "rgba(12,18,33,0.10)",
        "navy-border-mid": "rgba(12,18,33,0.20)",
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
