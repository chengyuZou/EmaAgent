// ── Ladle config ────────────────────────────────────────────────────────────
//
// Component playground. Each component will have a co-located `.stories.tsx`
// file. Run `pnpm --filter @ema-agent/ui ladle` to launch.
//
// We load our shared UnoCSS preset by injecting a uno.css entry that imports
// the styles from src.

/** @type {import('@ladle/react').UserConfig} */
export default {
  stories:   'components/**/*.stories.{ts,tsx}',
  defaultStory: 'atoms-button--variants',
  // 复用同目录的 vite.config.ts(仅接 UnoCSS),保证组件示例的原子类能生成 CSS。
  hotkeys: {
    fullscreen:  ['f'],
    storySearch: ['mod+/'],
  },
  outDir: 'ladle-build',
};
