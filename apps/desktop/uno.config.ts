import { defineConfig, presetUno, presetAttributify } from 'unocss';

export default defineConfig({
  presets: [
    presetUno(),          // Tailwind/Windi-compatible utilities
    presetAttributify(),  // <div flex flex-col /> shorthand (optional)
  ],
  // Scan all files in the desktop app + the desktop-ui package it imports from.
  content: {
    filesystem: [
      'src/**/*.{ts,tsx}',
      '../../../packages/desktop-ui/src/**/*.{ts,tsx}',
    ],
  },
});
