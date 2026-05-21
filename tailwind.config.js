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
          50: "#eef2ff", 100: "#e0e7ff", 200: "#c7d2fe", 300: "#a5b4fc",
          400: "#818cf8", 500: "#6366f1", 600: "#4f46e5", 700: "#4338ca",
          800: "#3730a3", 900: "#312e81",
        },
      },
    },
  },
  plugins: [],
};
