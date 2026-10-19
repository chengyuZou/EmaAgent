// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAttachmentDrop } from '../src/chat/input/attachmentDrop.js';
import { MainView, useMainNavigationStore } from '../src/layout/navigation.js';
import { WallpaperTab } from '../src/settings/appearance/wallpaperTab.js';
import { DEFAULT_WALLPAPER_SETTINGS } from '../../server/src/settings/wallpaperCatalog.js';
import { wallpaperSetting } from '@ema-agent/server/settings';
import type { FileDragEvent } from '../src/lib/tauri/types.js';

const boundary = vi.hoisted(() => ({
  listeners: new Set<(event: FileDragEvent) => void>(),
  inspect: vi.fn(),
  edit: vi.fn(),
  toast: vi.fn(),
  readImage: vi.fn(),
  upload: vi.fn(),
  listImages: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('../src/lib/tauri/tauriBridge.js', () => {
  async function listen(handler: (event: FileDragEvent) => void) {
    boundary.listeners.add(handler);
    return () => boundary.listeners.delete(handler);
  }
  return {
    tauriBridge: {
      listenFileDrag: listen,
      inspectAttachmentPaths: boundary.inspect,
      readLocalImage: boundary.readImage,
    },
  };
});
vi.mock('../src/chat/input/editChatDraft.js', () => ({ editChatDraft: boundary.edit }));
vi.mock('../src/chat/input/draftAttachments.js', () => ({
  appendAttachmentPaths: (draft: object, paths: string[]) => ({ ...draft, paths }),
}));
vi.mock('../src/lib/notifications/toast.js', () => ({ showToast: boundary.toast }));
vi.mock('../src/api/wallpaper.js', () => ({
  wallpaperApi: {
    uploadImage: boundary.upload,
    listImages: boundary.listImages,
    imagePath: (name: string) => name,
    thumbnailPath: (name: string) => name,
  },
}));
vi.mock('../src/api/settings.js', () => ({
  settingsApi: {
    getValue: async () => ({ value: DEFAULT_WALLPAPER_SETTINGS }),
    putValue: boundary.saveSettings,
  },
}));
vi.mock('../src/lib/images/serverImage.js', () => ({ ServerImage: () => null }));

let root: Root;
let host: HTMLDivElement;

function ChatDrop({ sessionId = null }: { sessionId?: string | null }): JSX.Element {
  const { dropAreaRef, overlayWidth } = useAttachmentDrop(sessionId);
  return (
    <main ref={dropAreaRef} data-chat-overlay={overlayWidth ?? 'none'}>
      <div data-ema-chat-column />
    </main>
  );
}

async function drop(paths = ['C:/wallpaper.png'], x = 500): Promise<void> {
  await act(async () => {
    for (const listener of boundary.listeners) {
      listener({ type: 'drop', x, y: 300, paths });
    }
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useMainNavigationStore.setState({ activeView: MainView.Chat, viewedSessionId: null });
  boundary.inspect.mockResolvedValue({ files: ['C:/wallpaper.png'], rejected: [] });
  boundary.listImages.mockResolvedValue({ items: [] });
  boundary.readImage.mockResolvedValue([137, 80, 78, 71]);
  boundary.upload.mockResolvedValue({ name: 'wallpaper.png', size: 4, modifiedAt: 1 });
  boundary.saveSettings.mockImplementation(async (_key, value) => ({ value }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return {
      left: 200, top: 50, right: this.hasAttribute('data-ema-chat-column') ? 900 : 1400,
      bottom: 950, width: 1200, height: 900, x: 200, y: 50, toJSON() {},
    };
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  boundary.listeners.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('native chat file drops', () => {
  it('ignores drops while the mounted chat page is behind Settings', async () => {
    await act(async () => root.render(<ChatDrop />));
    await act(async () => useMainNavigationStore.getState().setSettingsTab('appearance-wallpapers'));

    await drop();

    expect(boundary.inspect).not.toHaveBeenCalled();
    expect(boundary.edit).not.toHaveBeenCalled();
  });

  it('adds a file only within the visible middle chat column', async () => {
    await act(async () => root.render(<ChatDrop />));
    await drop(undefined, 1000);
    expect(boundary.edit).not.toHaveBeenCalled();
    await drop();
    expect(boundary.edit).toHaveBeenCalledWith(null, expect.any(Function));
  });

  it('keeps an accepted drop bound to its original Session during inspection', async () => {
    let finish!: (value: { files: string[]; rejected: string[] }) => void;
    boundary.inspect.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<ChatDrop sessionId="session-a" />));
    await drop();
    await act(async () => root.render(<ChatDrop sessionId="session-b" />));
    await act(async () => finish({ files: ['C:/wallpaper.png'], rejected: [] }));
    expect(boundary.edit).toHaveBeenCalledWith('session-a', expect.any(Function));
  });

  it('rejects JSON on Wallpaper without reading it or sending it to hidden Chat', async () => {
    useMainNavigationStore.getState().setSettingsTab('appearance-wallpapers');
    await act(async () => root.render(<><ChatDrop /><WallpaperTab /></>));
    await drop(['C:/package.json']);

    expect(host.textContent).toContain('壁纸只支持 PNG, JPG, JPEG 和 WebP 图片');
    expect(boundary.readImage).not.toHaveBeenCalled();
    expect(boundary.upload).not.toHaveBeenCalled();
    expect(boundary.inspect).not.toHaveBeenCalled();
    expect(boundary.edit).not.toHaveBeenCalled();
  });

  it('imports a dropped image through the wallpaper upload API only', async () => {
    useMainNavigationStore.getState().setSettingsTab('appearance-wallpapers');
    await act(async () => root.render(<><ChatDrop /><WallpaperTab /></>));
    await drop();

    expect(boundary.readImage).toHaveBeenCalledWith('C:/wallpaper.png');
    expect(boundary.upload).toHaveBeenCalledOnce();
    expect(boundary.upload.mock.calls[0]![0]).toBeInstanceOf(File);
    expect(boundary.upload.mock.calls[0]![0].name).toBe('wallpaper.png');
    expect(boundary.saveSettings).toHaveBeenCalledWith(wallpaperSetting, expect.objectContaining({
      activeImage: 'wallpaper.png', enabled: true,
    }));
    expect(boundary.edit).not.toHaveBeenCalled();
  });

  it('does not accept wallpaper drops outside the card or on another settings tab', async () => {
    useMainNavigationStore.getState().setSettingsTab('appearance-wallpapers');
    await act(async () => root.render(<><ChatDrop /><WallpaperTab /></>));
    await drop(undefined, 100);
    expect(boundary.readImage).not.toHaveBeenCalled();
    await act(async () => useMainNavigationStore.getState().setSettingsTab('appearance-fonts'));
    await drop();
    expect(boundary.readImage).not.toHaveBeenCalled();
    expect(boundary.edit).not.toHaveBeenCalled();
  });
});
