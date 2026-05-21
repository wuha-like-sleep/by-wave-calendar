/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/views/**/*.ejs",
    "./src/public/**/*.js",
    "./src/web/**/*.ts",
    "./src/routes/**/*.ts",
  ],
  safelist: [
    // Dynamic classes used by JS (e.g., toast color variants, brand bg highlights)
    "bg-emerald-600", "bg-red-600", "bg-slate-900",
    "bg-brand-50", "text-brand-700", "font-semibold",
    "flex", "hidden", "absolute", "z-30", "inset-y-0", "left-0",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "-apple-system", "BlinkMacSystemFont", "Segoe UI",
          "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
          "Helvetica Neue", "Helvetica", "Arial", "sans-serif",
        ],
      },
      colors: {
        brand: {
          50:  "rgb(var(--brand-50)  / <alpha-value>)",
          100: "rgb(var(--brand-100) / <alpha-value>)",
          200: "rgb(var(--brand-200) / <alpha-value>)",
          300: "rgb(var(--brand-300) / <alpha-value>)",
          400: "rgb(var(--brand-400) / <alpha-value>)",
          500: "rgb(var(--brand-500) / <alpha-value>)",
          600: "rgb(var(--brand-600) / <alpha-value>)",
          700: "rgb(var(--brand-700) / <alpha-value>)",
          800: "rgb(var(--brand-800) / <alpha-value>)",
          900: "rgb(var(--brand-900) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};
