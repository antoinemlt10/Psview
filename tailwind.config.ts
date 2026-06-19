import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: "var(--paper)",
        "paper-2": "var(--paper-2)",
        surface: "var(--surface)",
        line: "var(--line)",
        "line-2": "var(--line-2)",
        ink: "var(--ink)",
        "ink-2": "var(--ink-2)",
        muted: "var(--muted)",
        "ink-bg": "var(--ink-bg)",
        "ink-bg-2": "var(--ink-bg-2)",
        "on-dark": "var(--on-dark)",
        "on-dark-2": "var(--on-dark-2)",
        "line-dark": "var(--line-dark)",
      },
      fontFamily: {
        grotesk: ["var(--font-grotesk)"],
        mono: ["var(--font-mono)"],
        serif: ["var(--font-serif)", "Georgia", "serif"],
      },
      borderRadius: {
        lg: "10px",
        xl: "14px",
        "2xl": "20px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(13,13,13,0.04), 0 10px 30px -16px rgba(13,13,13,0.12)",
        lift: "0 2px 6px rgba(13,13,13,0.06), 0 24px 50px -22px rgba(13,13,13,0.28)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.45s ease both",
      },
    },
  },
  plugins: [],
};

export default config;
