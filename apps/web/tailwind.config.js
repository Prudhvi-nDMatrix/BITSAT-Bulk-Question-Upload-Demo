/** @type {import('tailwindcss').Config} */
export default {
  content: ["./apps/web/index.html", "./apps/web/src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["Instrument Serif", "serif"],
        sans: ["Inter", "system-ui", "sans-serif"]
      },
      boxShadow: {
        glow: "0 24px 80px rgba(20, 16, 12, 0.14)",
        card: "0 18px 40px rgba(56, 31, 11, 0.08)"
      }
    }
  },
  plugins: []
};
