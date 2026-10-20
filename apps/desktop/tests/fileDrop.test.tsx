// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@ema-agent/ui';
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
  getSettings: vi.fn(),
  isTauri: vi.fn(),
  selectPaths: vi.fn(),
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
      isTauri: boundary.isTauri,
      selectPaths: boundary.selectPaths,
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
    getValue: boundary.getSettings,
    putValue: boundary.saveSettings,
  },
}));
vi.mock('../src/lib/images/serverImage.js', () => ({ ServerImage: () => null }));

let root: Root;
let host: HTMLDivElement;
let savedSettings = DEFAULT_WALLPAPER_SETTINGS;

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
  boundary.isTauri.mockReturnValue(false);
  boundary.selectPaths.mockResolvedValue([]);
  boundary.upload.mockResolvedValue({ name: 'wallpaper.png', size: 4, modifiedAt: 1 });
  savedSettings = { ...DEFAULT_WALLPAPER_SETTINGS, images: {} };
  boundary.getSettings.mockImplementation(async () => ({ value: savedSettings }));
  boundary.saveSettings.mockImplementation(async (_key, value) => {
    savedSettings = value;
    return { value };
  });
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

describe('wallpaper drops after file selection', () => {
  async function renderWallpaper(): Promise<void> {
    useMainNavigationStore.getState().setSettingsTab('appearance-wallpapers');
    await act(async () => root.render(
      <TooltipProvider>
        <WallpaperTab />
      </TooltipProvider>,
    ));
  }

  function importButton(): HTMLButtonElement {
    return Array.from(host.querySelectorAll('button'))
      .find(button => button.textContent === '批量导入')!;
  }

  async function selectFiles(files: File[]): Promise<void> {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  async function enterDropArea(): Promise<void> {
    await act(async () => {
      for (const listener of boundary.listeners) {
        listener({ type: 'enter', x: 500, y: 300 });
      }
    });
    expect(host.querySelector('[data-file-drop-target]')?.getAttribute('data-drag-active'))
      .toBe('true');
  }

  it('keeps highlighting and accepting drops after opening and cancelling the file picker', async () => {
    const openPicker = vi.spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await renderWallpaper();

    await act(async () => importButton().click());
    expect(openPicker).toHaveBeenCalledOnce();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      input.dispatchEvent(new Event('cancel', { bubbles: true }));
    });

    expect(importButton().disabled).toBe(false);
    await enterDropArea();
    await drop();
    expect(boundary.readImage).toHaveBeenCalledWith('C:/wallpaper.png');
    expect(boundary.upload).toHaveBeenCalledOnce();
  });

  it('accepts another drop after importing a selected file and displaying its preview', async () => {
    await renderWallpaper();
    const image = { name: 'selected.png', size: 4, modifiedAt: 1 };
    boundary.upload.mockResolvedValueOnce(image);
    boundary.listImages.mockResolvedValue({ items: [image] });

    await selectFiles([new File(['image'], 'selected.png', { type: 'image/png' })]);

    expect(host.textContent).toContain('图库 · 1 张');
    expect(importButton().disabled).toBe(false);
    await enterDropArea();
    await drop();
    expect(boundary.readImage).toHaveBeenCalledWith('C:/wallpaper.png');
    expect(boundary.upload).toHaveBeenCalledTimes(2);
  });

  it('highlights and imports when the gallery already contains an image on entry', async () => {
    boundary.listImages.mockResolvedValue({
      items: [{ name: 'existing.png', size: 4, modifiedAt: 1 }],
    });
    await renderWallpaper();

    expect(host.textContent).toContain('图库 · 1 张');
    await enterDropArea();
    await drop();
    expect(boundary.readImage).toHaveBeenCalledWith('C:/wallpaper.png');
    expect(boundary.upload).toHaveBeenCalledOnce();
  });

  it('resumes drops after a selected file fails to upload', async () => {
    await renderWallpaper();
    boundary.upload.mockRejectedValueOnce(new Error('Upload failed'));

    await selectFiles([new File(['image'], 'failed.png', { type: 'image/png' })]);

    expect(host.textContent).toContain('图片导入失败: failed.png');
    expect(importButton().disabled).toBe(false);
    await enterDropArea();
    await drop();
    expect(boundary.readImage).toHaveBeenCalledWith('C:/wallpaper.png');
    expect(boundary.upload).toHaveBeenCalledTimes(2);
  });

  it('pauses drops only while the selected file import is still pending', async () => {
    await renderWallpaper();
    let finishUpload!: (image: { name: string; size: number; modifiedAt: number }) => void;
    boundary.upload.mockReturnValueOnce(new Promise(resolve => { finishUpload = resolve; }));

    await selectFiles([new File(['image'], 'pending.png', { type: 'image/png' })]);

    expect(importButton().disabled).toBe(true);
    expect(boundary.listeners.size).toBe(0);
    await drop();
    expect(boundary.readImage).not.toHaveBeenCalled();

    await act(async () => finishUpload({ name: 'pending.png', size: 4, modifiedAt: 1 }));

    expect(importButton().disabled).toBe(false);
    await enterDropArea();
    await drop();
    expect(boundary.readImage).toHaveBeenCalledWith('C:/wallpaper.png');
    expect(boundary.upload).toHaveBeenCalledTimes(2);
  });

  it('accepts drops while the native picker waits and serializes the later selection', async () => {
    boundary.isTauri.mockReturnValue(true);
    let select!: (paths: string[]) => void;
    let finishUpload!: (image: { name: string; size: number; modifiedAt: number }) => void;
    boundary.selectPaths.mockReturnValueOnce(new Promise(resolve => { select = resolve; }));
    boundary.upload.mockReturnValueOnce(new Promise(resolve => { finishUpload = resolve; }));
    boundary.upload.mockResolvedValueOnce({ name: 'selected.png', size: 4, modifiedAt: 2 });
    await renderWallpaper();

    await act(async () => importButton().click());
    expect(boundary.selectPaths).toHaveBeenCalledOnce();
    await enterDropArea();
    await drop(['C:/dropped.png']);
    await act(async () => select(['C:/selected.png']));
    expect(boundary.upload).toHaveBeenCalledOnce();
    expect(boundary.readImage).toHaveBeenCalledTimes(1);

    await act(async () => finishUpload({ name: 'dropped.png', size: 4, modifiedAt: 1 }));
    expect(boundary.upload).toHaveBeenCalledTimes(2);
    expect(Object.keys(savedSettings.images)).toEqual(['dropped.png', 'selected.png']);
    expect(savedSettings.activeImage).toBe('dropped.png');
  });

  it('reads current configuration when an old picker returns after the page remounts', async () => {
    boundary.isTauri.mockReturnValue(true);
    let select!: (paths: string[]) => void;
    boundary.selectPaths.mockReturnValueOnce(new Promise(resolve => { select = resolve; }));
    await renderWallpaper();
    await act(async () => importButton().click());
    await act(async () => root.render(null));
    savedSettings = {
      ...savedSettings,
      enabled: false,
      activeImage: 'existing.png',
      materialMode: 'frosted',
      images: { 'existing.png': { opacity: 0.61, blur: 9 } },
    };
    await renderWallpaper();
    boundary.listImages.mockResolvedValue({ items: [
      { name: 'existing.png', size: 4, modifiedAt: 1 },
      { name: 'wallpaper.png', size: 4, modifiedAt: 2 },
    ] });

    await act(async () => select(['C:/wallpaper.png']));

    expect(savedSettings).toMatchObject({
      enabled: false,
      activeImage: 'existing.png',
      materialMode: 'frosted',
      images: { 'existing.png': { opacity: 0.61, blur: 9 } },
    });
    expect(savedSettings.images['wallpaper.png']).toBeDefined();
    expect(host.textContent).toContain('图库 · 2 张');
  });

  it('keeps drops available after native selection cancellation or failure and dismisses errors', async () => {
    boundary.isTauri.mockReturnValue(true);
    await renderWallpaper();
    await act(async () => importButton().click());
    expect(boundary.upload).not.toHaveBeenCalled();
    boundary.selectPaths.mockRejectedValueOnce(new Error('Selection failed'));
    await act(async () => importButton().click());
    expect(host.textContent).toContain('Selection failed');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭壁纸错误提示"]')!.click());
    expect(host.textContent).not.toContain('Selection failed');
    await enterDropArea();
    await drop();
    expect(boundary.upload).toHaveBeenCalledOnce();
  });
});
