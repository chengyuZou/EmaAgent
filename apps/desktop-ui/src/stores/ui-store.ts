/**
 * UI store — cross-window UI state (theme / dock / TTS toggle / sub-window sync).
 */
import { create } from 'zustand';
import { tauriBridge } from '../lib/tauri-bridge.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SubWindowName = 'chat' | 'settings';

export interface UiStoreState {
  openSubWindows:        Set<SubWindowName>;
  theme:                 'dark' | 'light' | 'system';
  dockVisible:           boolean;
  ttsEnabled:            boolean;
  /** Context window of the model the user explicitly selected in ModelPicker. Null = using default binding. */
  selectedContextWindow: number | null;

  setTheme(theme: 'dark' | 'light' | 'system'): void;
  setDockVisible(value: boolean): void;
  setTtsEnabled(value: boolean): void;
  setSelectedContextWindow(n: number | null): void;

  notifySubWindowOpened(name: SubWindowName): Promise<void>;
  notifySubWindowClosed(name: SubWindowName): Promise<void>;
  startSubWindowSync(): Promise<() => void>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useUiStore = create<UiStoreState>((set, get) => ({
  openSubWindows:        new Set(),
  theme:                 'dark',
  dockVisible:           false,
  ttsEnabled:            false,
  selectedContextWindow: null,

  setTheme(theme) {
    set({ theme });
  },

  setDockVisible(value) {
    set({ dockVisible: value });
  },

  setTtsEnabled(value) {
    set({ ttsEnabled: value });
  },

  setSelectedContextWindow(n) {
    set({ selectedContextWindow: n });
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
