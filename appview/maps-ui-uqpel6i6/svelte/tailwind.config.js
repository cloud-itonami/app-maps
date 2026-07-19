import { etzhayyimUIKit } from '@etzhayyim/design-system/plugin';

export default {
  content: [
    './src/**/*.{html,js,svelte,ts}',
    '../../../../../packages/ts/design-system/dist/**/*.{svelte,js}',
    '../../../../../packages/ts/design-system/dist/**/*.{svelte,js}',
  ],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        etzhayyim: {
          bg: 'var(--gv2-bg-primary)',
          sidebar: 'var(--gv2-bg-sidebar)',
          hover: 'var(--gv2-bg-hover)',
          input: 'var(--gv2-bg-input)',
          card: 'var(--gv2-bg-card)',
          text: 'var(--gv2-text-primary)',
          secondary: 'var(--gv2-text-secondary)',
          muted: 'var(--gv2-text-muted)',
          accent: 'var(--gv2-accent)',
          'accent-hover': 'var(--gv2-accent-hover)',
          border: 'var(--gv2-border)',
        }
      },
      fontFamily: {
        sans: ["'Noto Sans JP'", '-apple-system', 'BlinkMacSystemFont', "'Segoe UI'", "'Hiragino Kaku Gothic ProN'", 'sans-serif'],
      }
    }
  },
  plugins: [etzhayyimUIKit],
};
