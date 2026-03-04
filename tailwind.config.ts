import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          primary: '#08080A',
          card: '#111113',
        },
        border: {
          DEFAULT: '#2A2A2F',
          hover: '#3A3A40',
        },
        text: {
          primary: '#EDEAE5',
          secondary: '#807D78',
          tertiary: '#5A5855',
        },
        accent: {
          DEFAULT: '#C8956B',
          hover: '#D8A57B',
        },
      },
      fontFamily: {
        display: ['Playfair Display', 'serif'],
        body: ['Outfit', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
