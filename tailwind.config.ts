import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        obsidian: '#030303',
        silver: '#8E8E93',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        // Specular top-edge highlight + deep ambient drop used by every glass surface.
        glass: 'inset 0 1px 1px rgba(255,255,255,0.22), 0 20px 50px rgba(0,0,0,0.85)',
        'glass-sm': 'inset 0 1px 1px rgba(255,255,255,0.16), 0 10px 30px rgba(0,0,0,0.6)',
        'glass-inset': 'inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -1px 0 rgba(0,0,0,0.4)',
      },
      keyframes: {
        // Breathes in translate and opacity only. A scale above 1 would make the
        // element's box wider than the viewport by construction, which - even
        // clipped - is an overflow that never needs to exist.
        'ambient-drift': {
          '0%, 100%': { transform: 'translate3d(0, 0, 0)', opacity: '0.85' },
          '50%': { transform: 'translate3d(0, -2%, 0)', opacity: '1' },
        },
        'sheen-sweep': {
          '0%': { transform: 'translateX(-120%)' },
          '100%': { transform: 'translateX(220%)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.92)', opacity: '0.7' },
          '100%': { transform: 'scale(1.5)', opacity: '0' },
        },
        'shimmer-line': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'ambient-drift': 'ambient-drift 18s ease-in-out infinite',
        'sheen-sweep': 'sheen-sweep 2.6s cubic-bezier(0.4,0,0.2,1) infinite',
        'pulse-ring': 'pulse-ring 1.6s cubic-bezier(0.4,0,0.2,1) infinite',
        'shimmer-line': 'shimmer-line 1.8s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
