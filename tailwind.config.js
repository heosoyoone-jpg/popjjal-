/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        pop: {
          pink: "#FF85A1",
          yellow: "#FFD166",
        },
      },
      fontFamily: {
        sans: ["Pretendard", "-apple-system", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
