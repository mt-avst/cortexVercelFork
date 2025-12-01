/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Map Tailwind to your existing CSS tokens
        primary: 'var(--accent-primary)',
        'primary-foreground': 'var(--text-inverse)',
        secondary: 'var(--accent-secondary)',
        'secondary-foreground': 'var(--text-primary)',
        background: 'var(--bg-primary)',
        foreground: 'var(--text-primary)',
        muted: {
          DEFAULT: 'var(--bg-secondary)',
          foreground: 'var(--text-muted)',
        },
        accent: {
          DEFAULT: 'var(--accent-primary)',
          foreground: 'var(--text-inverse)',
        },
        destructive: {
          DEFAULT: 'var(--status-error)',
          foreground: 'var(--text-inverse)',
        },
        border: 'var(--border-primary)',
        input: 'var(--border-primary)',
        ring: 'var(--accent-primary)',
        card: {
          DEFAULT: 'var(--bg-card)',
          foreground: 'var(--text-primary)',
        },
        popover: {
          DEFAULT: 'var(--bg-card)',
          foreground: 'var(--text-primary)',
        },
      },
      borderRadius: {
        DEFAULT: 'var(--radius-md)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Clash Grotesk', 'Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

