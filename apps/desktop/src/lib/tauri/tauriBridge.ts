import type { AppEvent } from '@ema-agent/server/application/appEvents.js';
import type { ThemeSettings } from '@ema-agent/server/settings/themeSetting.js';

import type {
  FileDragEvent,
  BrowserBounds,
  BrowserEvent,
  DecisionRequiredEvent,
  DesktopSettingsPayload,
  Live2dPreviewCommand,
  OpenTerminalInput,
  PetPointerEvent,
  SelectPathsOptions,
  TerminalEvent,
} from './types.js';


let _detected: boolean | null = null;

function detectTauri(): boolean {
  if (_detected !== null) return _detected;
  try {
    _detected = '__TAURI_INTERNALS__' in window;
  } catch {
    _detected = false;
  }
  return _detected;
}


// 普通浏览器不能使用原生 IPC, 只有检测到 Tauri 后才加载这些模块.
type TauriCore   = typeof import('@tauri-apps/api/core');
type TauriEvent  = typeof import('@tauri-apps/api/event');
type TauriDialog = typeof import('@tauri-apps/plugin-dialog');
type TauriWindow = typeof import('@tauri-apps/api/window');

let _core:   TauriCore   | null = null;
let _event:  TauriEvent  | null = null;
let _dialog: TauriDialog | null = null;
let _window: TauriWindow | null = null;
const terminalChannels = new Map<string, object>();
const pendingBrowserOpens = new Map<string, Promise<void>>();
const pendingBrowserVisibility = new Map<string, Promise<void>>();

const WINDOW_VISIBILITY_EVENT = 'ema://window-visibility';
const PET_PASSTHROUGH_EVENT = 'ema://pet-passthrough';
const PET_POINTER_EVENT = 'ema://pet-pointer';
const SYSTEM_EVENT = 'ema://system-event';
const THEME_CHANGED_EVENT = 'theme:changed';
const DESKTOP_SETTINGS_CHANGED_EVENT = 'settings:desktop-changed';
const DIALOGUE_DELTA_EVENT = 'dialogue:delta';
const DIALOGUE_ENDED_EVENT = 'dialogue:end';
const DECISION_REQUIRED_EVENT = 'decision:push';
const DECISION_DISMISSED_EVENT = 'decision:dismiss';
const STAGE_EMOTION_EVENT = 'stage:emotion-changed';
const STAGE_MOTION_EVENT = 'stage:motion-changed';
const STAGE_LIP_SYNC_EVENT = 'stage:lip-sync';
const STAGE_LIVE2D_PREVIEW_EVENT = 'stage:live2d-preview';
const BROWSER_EVENT = 'browser:event';

async function getCore(): Promise<TauriCore | null> {
  if (!detectTauri()) return null;
  if (_core) return _core;
  try {
    _core = await import('@tauri-apps/api/core');
    return _core;
  } catch (cause) {
    throw new Error('Tauri Core 加载失败, 桌面命令不可用', { cause });
  }
}

async function getEvent(): Promise<TauriEvent | null> {
  if (!detectTauri()) return null;
  if (_event) return _event;
  try {
    _event = await import('@tauri-apps/api/event');
    return _event;
  } catch (cause) {
    throw new Error('Tauri Event 加载失败, 跨窗口事件不可用', { cause });
  }
}

async function getDialog(): Promise<TauriDialog | null> {
  if (!detectTauri()) return null;
  if (_dialog) return _dialog;
  try {
    _dialog = await import('@tauri-apps/plugin-dialog');
    return _dialog;
  } catch {
    return null;
  }
}

async function getWindow(): Promise<TauriWindow | null> {
  if (!detectTauri()) return null;
  if (_window) return _window;
  try {
    _window = await import('@tauri-apps/api/window');
    return _window;
  } catch {
    return null;
  }
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  const core = await getCore();
  if (!core) return null;
  return core.invoke<T>(command, args);
}

async function emitTauri(eventName: string, payload?: unknown): Promise<void> {
  const event = await getEvent();
  if (!event) return;
  await event.emit(eventName, payload);
}

async function listenTauri<T>(
  eventName: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const event = await getEvent();
  if (!event) return () => {};
  const unlisten = await event.listen<T>(eventName, ({ payload }) => handler(payload));
  return () => unlisten();
}


export const tauriBridge = {
  isTauri: detectTauri,

  async listenFileDrag(handler: (event: FileDragEvent) => void): Promise<() => void> {
    if (!detectTauri()) return () => {};
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    const webview = getCurrentWebview();
    return webview.onDragDropEvent(({ payload }) => {
      if (payload.type === 'leave') {
        handler({ type: 'leave' });
        return;
      }
      const x = payload.position.x / window.devicePixelRatio;
      const y = payload.position.y / window.devicePixelRatio;
      if (payload.type === 'drop') {
        handler({ type: 'drop', x, y, paths: payload.paths });
      } else {
        handler({ type: payload.type, x, y });
      }
    });
  },

  async inspectAttachmentPaths(paths: readonly string[]): Promise<{ files: string[]; rejected: string[] }> {
    const core = await getCore();
    if (!core) throw new Error('当前环境无法读取本机附件');
    return core.invoke('inspect_attachment_paths', { paths });
  },

  /** null 解除窗口的颜色覆盖, 让原生窗口和 WebView 重新跟随系统. */
  async setWindowTheme(mode: 'light' | 'dark' | null): Promise<void> {
    const winMod = await getWindow();
    if (!winMod) return;
    await winMod.getCurrentWindow().setTheme(mode);
  },

  async isWindowVisible(): Promise<boolean | null> {
    const winMod = await getWindow();
    if (!winMod) return null;
    const currentWindow = winMod.getCurrentWindow();
    try {
      const [visible, minimized] = await Promise.all([
        currentWindow.isVisible(),
        currentWindow.isMinimized(),
      ]);
      return visible && !minimized;
    } catch {
      return null;
    }
  },

  async listenWindowVisibility(handler: (visible: boolean) => void): Promise<() => void> {
    const winMod = await getWindow();
    if (!winMod) return () => {};
    return winMod.getCurrentWindow().listen<{ visible: boolean }>(
      WINDOW_VISIBILITY_EVENT,
      ({ payload }) => handler(payload.visible),
    );
  },

  async publishSystemEvent(event: AppEvent): Promise<void> {
    await emitTauri(SYSTEM_EVENT, event);
  },

  async listenSystemEvents(handler: (event: AppEvent) => void): Promise<() => void> {
    return listenTauri(SYSTEM_EVENT, handler);
  },

  async publishThemeChanged(theme: ThemeSettings): Promise<void> {
    await emitTauri(THEME_CHANGED_EVENT, theme);
  },

  async listenThemeChanged(handler: (theme: ThemeSettings) => void): Promise<() => void> {
    return listenTauri(THEME_CHANGED_EVENT, handler);
  },

  async publishDesktopSettingsChanged(settings: DesktopSettingsPayload): Promise<void> {
    await emitTauri(DESKTOP_SETTINGS_CHANGED_EVENT, settings);
  },

  async listenDesktopSettingsChanged(
    handler: (settings: DesktopSettingsPayload) => void,
  ): Promise<() => void> {
    return listenTauri(DESKTOP_SETTINGS_CHANGED_EVENT, handler);
  },

  async publishDialogueDelta(sessionId: string, turnId: string, text: string): Promise<void> {
    await emitTauri(DIALOGUE_DELTA_EVENT, { sessionId, turnId, text });
  },

  async publishDialogueEnded(sessionId: string, turnId: string): Promise<void> {
    await emitTauri(DIALOGUE_ENDED_EVENT, { sessionId, turnId });
  },

  async listenDialogueDelta(
    handler: (sessionId: string, turnId: string, text: string) => void,
  ): Promise<() => void> {
    return listenTauri<{ sessionId: string; turnId: string; text: string }>(
      DIALOGUE_DELTA_EVENT,
      ({ sessionId, turnId, text }) => handler(sessionId, turnId, text),
    );
  },

  async listenDialogueEnded(
    handler: (sessionId: string, turnId: string) => void,
  ): Promise<() => void> {
    return listenTauri<{ sessionId: string; turnId: string }>(
      DIALOGUE_ENDED_EVENT,
      ({ sessionId, turnId }) => handler(sessionId, turnId),
    );
  },

  async publishDecisionRequired(event: DecisionRequiredEvent): Promise<void> {
    await emitTauri(DECISION_REQUIRED_EVENT, event);
  },

  async publishDecisionDismissed(toolCallId: string): Promise<void> {
    await emitTauri(DECISION_DISMISSED_EVENT, { toolCallId });
  },

  async listenDecisionRequired(
    handler: (event: DecisionRequiredEvent) => void,
  ): Promise<() => void> {
    return listenTauri(DECISION_REQUIRED_EVENT, handler);
  },

  async listenDecisionDismissed(handler: (toolCallId: string) => void): Promise<() => void> {
    return listenTauri<{ toolCallId: string }>(
      DECISION_DISMISSED_EVENT,
      ({ toolCallId }) => handler(toolCallId),
    );
  },

  async publishStageEmotion(emotion: string): Promise<void> {
    await emitTauri(STAGE_EMOTION_EVENT, { emotion });
  },

  async publishStageMotion(motion: string): Promise<void> {
    await emitTauri(STAGE_MOTION_EVENT, { motion });
  },

  async publishStageLipSync(speaking: boolean, mouthOpen: number): Promise<void> {
    await emitTauri(STAGE_LIP_SYNC_EVENT, { speaking, mouthOpen });
  },

  async publishLive2dPreview(command: Live2dPreviewCommand): Promise<void> {
    await emitTauri(STAGE_LIVE2D_PREVIEW_EVENT, command);
  },

  async listenStageEmotion(
    handler: (emotion: string) => void,
  ): Promise<() => void> {
    return listenTauri<{ emotion: string }>(
      STAGE_EMOTION_EVENT,
      ({ emotion }) => handler(emotion),
    );
  },

  async listenStageMotion(
    handler: (motion: string) => void,
  ): Promise<() => void> {
    return listenTauri<{ motion: string }>(
      STAGE_MOTION_EVENT,
      ({ motion }) => handler(motion),
    );
  },

  async listenStageLipSync(
    handler: (speaking: boolean, mouthOpen: number) => void,
  ): Promise<() => void> {
    return listenTauri<{ speaking: boolean; mouthOpen: number }>(
      STAGE_LIP_SYNC_EVENT,
      ({ speaking, mouthOpen }) => handler(speaking, mouthOpen),
    );
  },

  async listenLive2dPreview(handler: (command: Live2dPreviewCommand) => void): Promise<() => void> {
    return listenTauri<Live2dPreviewCommand>(STAGE_LIVE2D_PREVIEW_EVENT, handler);
  },

  async openMainWindow(): Promise<void> {
    await invokeTauri('open_main_window');
  },

  async hideMainWindow(): Promise<void> {
    await invokeTauri('hide_main_window');
  },

  async minimizeWindow(): Promise<void> {
    const module = await getWindow();
    if (!module) {
      return;
    }
    await module.getCurrentWindow().minimize();
  },

  async toggleMaximizeWindow(): Promise<void> {
    const module = await getWindow();
    if (!module) {
      return;
    }
    await module.getCurrentWindow().toggleMaximize();
  },

  async listenWindowMaximized(handler: (maximized: boolean) => void): Promise<() => void> {
    const module = await getWindow();
    if (!module) {
      return () => {};
    }
    const currentWindow = module.getCurrentWindow();
    const unlisten = await currentWindow.onResized(() => {
      void currentWindow.isMaximized().then(handler).catch(error => {
        console.warn('[main] 读取窗口大小状态失败', error);
      });
    });
    try {
      handler(await currentWindow.isMaximized());
    } catch (error) {
      unlisten();
      throw error;
    }
    return unlisten;
  },

  async quit(): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('quit_app');
  },

  async setAlwaysOnTop(value: boolean): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('set_always_on_top', { value });
  },

  async setPassthrough(value: boolean): Promise<void> {
    const core = await getCore();
    if (!core) throw new Error('点击穿透只能在桌宠窗口使用');
    await core.invoke('set_passthrough', { value });
  },

  async getPassthrough(): Promise<boolean> {
    const core = await getCore();
    if (!core) throw new Error('点击穿透只能在桌宠窗口使用');
    return core.invoke<boolean>('get_passthrough');
  },

  async listenPassthrough(handler: (enabled: boolean) => void): Promise<() => void> {
    return listenTauri<boolean>(PET_PASSTHROUGH_EVENT, handler);
  },

  async listenPetPointer(handler: (event: PetPointerEvent) => void): Promise<() => void> {
    return listenTauri<PetPointerEvent>(PET_POINTER_EVENT, handler);
  },

  async startPetPointer(): Promise<void> {
    const core = await getCore();
    if (!core) throw new Error('系统鼠标跟随只能在桌宠窗口使用');
    await core.invoke('start_pet_pointer');
  },

  async setPassthroughControlsHovered(hovered: boolean): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('set_passthrough_controls_hovered', { hovered });
  },

  async startDragging(): Promise<void> {
    const winMod = await getWindow();
    if (!winMod) return;
    await winMod.getCurrentWindow().startDragging();
  },

  async getServerSecret(): Promise<string | null> {
    return invokeTauri<string>('get_server_secret');
  },

  async getServerPort(): Promise<number | null> {
    return invokeTauri<number>('get_server_port');
  },

  /** 本机字体每次运行只枚举一次; 取不到时返回空数组, 页面仍可显示内置推荐项. */
  async listSystemFonts(): Promise<string[]> {
    return (await invokeTauri<string[]>('list_system_fonts')) ?? [];
  },

  // 此入口在 Windows 上不禁用主窗口. 返回结果的业务归属由发起方保留.
  async selectPaths(options: SelectPathsOptions = {}): Promise<string[]> {
    const core = await getCore();
    if (!core) throw new Error('请在桌面窗口中选择本机文件');
    try {
      return await core.invoke<string[]>('select_paths', { options });
    } catch (cause) {
      throw cause instanceof Error ? cause : new Error(String(cause));
    }
  },

  async saveFileDialog(opts = {}): Promise<string | null> {
    const dialog = await getDialog();
    if (!dialog) return null;
    return dialog.save(opts);
  },

  async openFileDialog(opts = {}): Promise<string | null> {
    const dialog = await getDialog();
    if (!dialog) return null;
    const result = await dialog.open({ multiple: false, ...opts });
    if (Array.isArray(result)) return result[0] ?? null;
    return result as string | null;
  },

  async openFileDialogMultiple(opts = {}): Promise<string[]> {
    const dialog = await getDialog();
    if (!dialog) return [];
    const result = await dialog.open({ multiple: true, ...opts });
    if (Array.isArray(result)) return result as string[];
    // 单个结果也返回数组, 取消选择返回空数组.
    return result ? [result as string] : [];
  },

  async openUrl(url: string): Promise<void> {
    // 原生调用 opener 插件, 插件不可用时沿用浏览器的 window.open.
    const core = await getCore();
    if (core) {
      try {
        await core.invoke('plugin:opener|open_url', { url });
        return;
      } catch {
        // 继续执行浏览器打开逻辑.
      }
    }
    window.open(url, '_blank');
  },

  /** 在系统文件管理器中定位路径(后台进程日志目录等), 插件缺失时抛错由调用方提示. */
  async revealInFolder(path: string): Promise<void> {
    const core = await getCore();
    if (!core) throw new Error('当前环境不支持文件管理器定位');
    await core.invoke('plugin:opener|reveal_item_in_dir', { paths: [path] });
  },

  /** 用系统默认方式打开路径本身, 失败抛错由调用方提示. */
  async openPath(path: string): Promise<void> {
    const core = await getCore();
    if (!core) throw new Error('当前环境不支持打开路径');
    await core.invoke('open_path', { path });
  },

  async openTerminal(input: OpenTerminalInput): Promise<void> {
    const core = await getCore();
    if (!core) throw new Error('当前环境不支持交互终端');
    const channel = new core.Channel<TerminalEvent>((event) => {
      input.onEvent(event);
      if (event.type === 'exit') terminalChannels.delete(input.terminalId);
    });
    terminalChannels.set(input.terminalId, channel);
    try {
      await core.invoke('open_terminal', {
        terminalId: input.terminalId,
        sessionId: input.sessionId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.shell ? { shell: input.shell } : {}),
        columns: input.columns,
        rows: input.rows,
        onEvent: channel,
      });
    } catch (error) {
      terminalChannels.delete(input.terminalId);
      throw error;
    }
  },

  async writeTerminal(terminalId: string, data: string): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('write_terminal', { terminalId, data });
  },

  async resizeTerminal(terminalId: string, columns: number, rows: number): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('resize_terminal', { terminalId, columns, rows });
  },

  async closeTerminal(terminalId: string): Promise<void> {
    terminalChannels.delete(terminalId);
    const core = await getCore();
    if (!core) return;
    await core.invoke('close_terminal', { terminalId });
  },

  async closeSessionTerminals(sessionId: string): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('close_session_terminals', { sessionId });
  },

  async openBrowser(browserId: string, url: string, bounds: BrowserBounds): Promise<void> {
    const pending = pendingBrowserOpens.get(browserId);
    if (pending) return pending;

    const opening = (async () => {
      const core = await getCore();
      if (!core) throw new Error('当前环境不支持内置浏览器');
      await core.invoke('open_browser', { browserId, url, bounds });
    })();
    pendingBrowserOpens.set(browserId, opening);
    try {
      await opening;
    } finally {
      if (pendingBrowserOpens.get(browserId) === opening) {
        pendingBrowserOpens.delete(browserId);
      }
    }
  },

  async navigateBrowser(browserId: string, url: string): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('navigate_browser', { browserId, url });
  },

  async browserBack(browserId: string): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('browser_back', { browserId });
  },

  async browserForward(browserId: string): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('browser_forward', { browserId });
  },

  async reloadBrowser(browserId: string): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('reload_browser', { browserId });
  },

  async setBrowserBounds(browserId: string, bounds: BrowserBounds): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('set_browser_bounds', { browserId, bounds });
  },

  async setBrowserVisible(browserId: string, visible: boolean): Promise<void> {
    const previous = pendingBrowserVisibility.get(browserId) ?? Promise.resolve();
    const update = previous.catch(() => {}).then(async () => {
      const core = await getCore();
      if (!core) return;
      await core.invoke('set_browser_visible', { browserId, visible });
    });
    pendingBrowserVisibility.set(browserId, update);
    try {
      await update;
    } finally {
      if (pendingBrowserVisibility.get(browserId) === update) {
        pendingBrowserVisibility.delete(browserId);
      }
    }
  },

  /** 读取原生选择或拖入的图片字节. 预览和上传共用此入口, 此处不保存文件. */
  async readLocalImage(path: string): Promise<number[]> {
    const core = await getCore();
    if (!core) throw new Error('当前环境无法读取本机图片');
    return core.invoke<number[]>('read_local_image', { path });
  },

  async closeBrowser(browserId: string): Promise<void> {
    await pendingBrowserOpens.get(browserId)?.catch(() => {});
    await pendingBrowserVisibility.get(browserId)?.catch(() => {});
    const core = await getCore();
    if (!core) return;
    await core.invoke('close_browser', { browserId });
  },

  async listenBrowserEvents(handler: (event: BrowserEvent) => void): Promise<() => void> {
    return listenTauri(BROWSER_EVENT, handler);
  },
};
