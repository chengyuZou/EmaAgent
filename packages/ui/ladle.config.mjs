// ── Ladle config ────────────────────────────────────────────────────────────
//
// Component playground. Each component will have a co-located `.stories.tsx`
// file. Run `pnpm --filter @ema-agent/ui ladle` to launch.
//
// We load our shared UnoCSS preset by injecting a uno.css entry that imports
// the styles from src.

/** @type {import('@ladle/react').UserConfig} */
export default {
  stories:   'src/**/*.stories.{ts,tsx}',
  defaultStory: 'atoms-button--variants',
  // Use the same Vite config dir; Ladle picks up vite.config.* automatically
  // if present. We don't ship one yet — Ladle's defaults are fine for now.
  hotkeys: {
    fullscreen:  ['f'],
    storySearch: ['mod+/'],
  },
  outDir: 'ladle-build',
};
