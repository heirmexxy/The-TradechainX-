import type { Config } from "tailwindcss";

// Palette: Adire indigo (Oyo State's dye tradition) for ink and structure, maize gold for the one
// accent, leaf green reserved for "verified". Cool paper white, not cream.
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#1E2A5A", 900: "#141C3F", 700: "#2B3A78", 500: "#4A5A9C", 100: "#E4E8F4", 50: "#F1F3FA" },
        paper: "#F7F8FA",
        maize: { DEFAULT: "#E0A526", 700: "#A8740D", 100: "#FBF0D6" },
        leaf: { DEFAULT: "#2F7D4F", 100: "#DDF0E4" },
        slate: { DEFAULT: "#3B4256", 500: "#6B7285", 300: "#AEB3C2" },
        line: "#D9DDE6",
        danger: { DEFAULT: "#B42318", 100: "#FDE7E4" },
      },
      fontFamily: {
        sans: ["var(--font-plex)", "system-ui", "sans-serif"],
      },
      fontSize: {
        // Modular scale (1.25), set for Plex's large x-height.
        hero: ["clamp(2.6rem, 6vw, 4.6rem)", { lineHeight: "1.02", letterSpacing: "-0.035em", fontWeight: "600" }],
        h1: ["2.25rem", { lineHeight: "1.1", letterSpacing: "-0.025em", fontWeight: "600" }],
        h2: ["1.6rem", { lineHeight: "1.2", letterSpacing: "-0.015em", fontWeight: "600" }],
        h3: ["1.15rem", { lineHeight: "1.35", fontWeight: "600" }],
      },
      maxWidth: { prose: "68ch" },
      borderRadius: { DEFAULT: "6px" },
    },
  },
  plugins: [],
} satisfies Config;
