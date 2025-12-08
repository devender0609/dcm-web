/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        clinicBlue: "#0060A8",
        clinicTeal: "#22B8B0",
        clinicPurple: "#6C3FA4",
        clinicGold: "#F4B000"
      },
      boxShadow: {
        glow: "0 0 40px rgba(34,184,176,0.35)"
      }
    }
  },
  plugins: []
};
