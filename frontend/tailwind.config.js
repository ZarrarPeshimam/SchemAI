/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        dark: {
          950: '#090D14', // deepest canvas
          900: '#0D111A', // main background
          850: '#111622', // workspace panels
          800: '#161D2B', // card / panel header
          750: '#1C2436', // elevated hover / active
          700: '#232D42', // border default
          600: '#2D3A54', // subtle border / divider
          500: '#4A5B7D', // muted icons / tags
          400: '#7E8EA8', // secondary text
          300: '#A4B3CA', // subdued text
          200: '#CBD5E1', // normal text
          100: '#E2E8F0', // bright text
          50: '#F8FAFC',  // highlight text
        },
        brand: {
          50: '#EFF6FF',
          500: '#3B82F6',
          600: '#2563EB',
          700: '#1D4ED8',
        },
        emerald: {
          400: '#34D399',
          500: '#10B981',
          900: '#064E3B',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Menlo', 'Consolas', 'monospace'],
      }
    },
  },
  plugins: [],
}
