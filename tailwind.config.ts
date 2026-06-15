import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          0: 'var(--bg-0)',
          1: 'var(--bg-1)',
          2: 'var(--bg-2)',
          3: 'var(--bg-3)',
          4: 'var(--bg-4)',
        },
        border: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        text: {
          1: 'var(--text-1)',
          2: 'var(--text-2)',
          3: 'var(--text-3)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
        },
        danger: 'var(--danger)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        track: {
          video: 'var(--track-video)',
          audio: 'var(--track-audio)',
          text: 'var(--track-text)',
          fx: 'var(--track-fx)',
        },
        'tl-accent': 'var(--timeline-accent)',
        'tl-bg': 'var(--timeline-bg)',
        'tl-sidebar': 'var(--timeline-sidebar-bg)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': '11px',
        xs: '12px',
        sm: '13px',
        base: '14px',
      },
      borderRadius: {
        sm: '4px',
        DEFAULT: '6px',
        lg: '8px',
      },
      boxShadow: {
        e1: '0 1px 2px rgba(0,0,0,.3)',
        e2: '0 8px 24px rgba(0,0,0,.4)',
        e3: '0 16px 48px rgba(0,0,0,.5)',
      },
      keyframes: {
        indeterminate: {
          '0%': { left: '-40%' },
          '100%': { left: '100%' },
        },
        // Effect/transition hover previews
        'zoom-in-preview': {
          '0%': { transform: 'scale(1)' },
          '100%': { transform: 'scale(1.35)' },
        },
        'zoom-out-preview': {
          '0%': { transform: 'scale(1.35)' },
          '100%': { transform: 'scale(1)' },
        },
        'fade-in-preview': {
          '0%': { opacity: '0.05' },
          '100%': { opacity: '1' },
        },
        'fade-out-preview': {
          '0%': { opacity: '1' },
          '100%': { opacity: '0.05' },
        },
      },
      animation: {
        indeterminate: 'indeterminate 1.1s ease-in-out infinite',
        'zoom-in-preview': 'zoom-in-preview 1.4s ease-in-out infinite alternate',
        'zoom-out-preview': 'zoom-out-preview 1.4s ease-in-out infinite alternate',
        'fade-in-preview': 'fade-in-preview 1.4s ease-in-out infinite alternate',
        'fade-out-preview': 'fade-out-preview 1.4s ease-in-out infinite alternate',
      },
    },
  },
  plugins: [],
}

export default config
