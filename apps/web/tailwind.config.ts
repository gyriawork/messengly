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
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
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
    },
  },
  plugins: [],
};

export default config;
