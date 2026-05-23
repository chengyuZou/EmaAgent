/**
 * UI store — cross-window UI state (theme / dock / TTS toggle / sub-window sync).
 */
import { create } from 'zustand';
import { tauriBridge } from '../lib/tauri-bridge.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SubWindowName = 'chat' | 'settings';

export interface UiStoreState {
  openSubWindows: Set<SubWindowName>;
  theme:          'dark' | 'light' | 'system';
  dockVisible:    boolean;
  ttsEnabled:     boolean;

  setTheme(theme: 'dark' | 'light' | 'system'): void;
  setDockVisible(value: boolean): void;
  setTtsEnabled(value: boolean): void;

  notifySubWindowOpened(name: SubWindowName): Promise<void>;
  notifySubWindowClosed(name: SubWindowName): Promise<void>;
  startSubWindowSync(): Promise<() => void>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useUiStore = create<UiStoreState>((set, get) => ({
  openSubWindows: new Set(),
  theme:          'dark',
  dockVisible:    false,
  ttsEnabled:     false,

  setTheme(theme) {
    set({ theme });
  },

  setDockVisible(value) {
    set({ dockVisible: value });
  },

  setTtsEnabled(value) {
    set({ ttsEnabled: value });
  },

  async notifySubWindowOpened(name) {
    const next = new Set(get().openSubWindows);
    next.add(name);
    set({ openSubWindows: next });
    await tauriBridge.emit('ui:window-opened', { name });
  },

  async notifySubWindowClosed(name) {
    const next = new Set(get().openSubWindows);
    next.delete(name);
    set({ openSubWindows: next });
    await tauriBridge.emit('ui:window-closed', { name });
  },

  async startSubWindowSync() {
    const unlistenOpen = await tauriBridge.listen<{ name: SubWindowName }>(
      'ui:window-opened',
      (event) => {
        const next = new Set(get().openSubWindows);
        next.add(event.payload.name);
        set({ openSubWindows: next });
      },
    );

    const unlistenClose = await tauriBridge.listen<{ name: SubWindowName }>(
      'ui:window-closed',
      (event) => {
        const next = new Set(get().openSubWindows);
        next.delete(event.payload.name);
        set({ openSubWindows: next });
      },
    );

    return () => {
      unlistenOpen();
      unlistenClose();
    };
  },
}));
