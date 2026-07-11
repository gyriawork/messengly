import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#6366f1',
          hover: '#4f46e5',
          bg: '#eef2ff',
        },
        messenger: {
          tg: { bg: '#e6f1fb', text: '#0c447c' },
          sl: { bg: '#eeedfe', text: '#3c3489' },
          wa: { bg: '#eaf3de', text: '#3b6d11' },
          gm: { bg: '#fcebeb', text: '#a32d2d' },
          mt: { bg: '#eceafa', text: '#4b53bc' },
        },
      },
      fontFamily: {
        sans: ['Figtree', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '8px',
        lg: '12px',
        xl: '16px',
        full: '20px',
        avatar: '14px',
        bubble: '18px',
      },
      boxShadow: {
        xs: '0 1px 2px rgba(0,0,0,0.05)',
        sm: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)',
        'accent-sm': '0 1px 2px rgba(99,102,241,0.3)',
        'focus-ring': '0 0 0 3px rgba(99,102,241,0.15)',
      },
      // Motion scale (docs/ANIMATION_AUDIT.md): transform/opacity only, so
      // every animation stays on the compositor. Use behind `motion-safe:`.
      keyframes: {
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'overlay-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'modal-in': {
          from: { opacity: '0', transform: 'scale(0.97) translateY(8px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        'step-in': {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.8)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(100%)' },
        },
        'skeleton-in': {
          to: { opacity: '1' },
        },
        'stripe-slide': {
          from: { backgroundPosition: '0 0' },
          to: { backgroundPosition: '1rem 0' },
        },
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.2s ease-out both',
        'overlay-in': 'overlay-in 0.15s ease-out both',
        'modal-in': 'modal-in 0.2s ease-out both',
        'step-in': 'step-in 0.15s ease-out both',
        'scale-in': 'scale-in 0.3s ease-out both',
        shimmer: 'shimmer 1.2s linear infinite',
        'skeleton-in': 'skeleton-in 0.2s ease-out 0.15s forwards',
        'stripe-slide': 'stripe-slide 0.8s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
