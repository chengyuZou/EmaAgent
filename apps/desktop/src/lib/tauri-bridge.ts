/**
 * Tauri 桥接层——所有 Tauri IPC 通信的唯一统一入口。
 *
 * 所有 `@tauri-apps/api/*` 的导入都集中在这里。
 * `apps/desktop/src` 中的其他文件都不允许直接导入 `@tauri-apps/api`。
 * 这样可以为普通浏览器环境提供降级方案，使 Ladle stories
 * 和单元测试即使没有 Tauri 运行时也能正常渲染。
 */
import { convertFileSrc as tauriConvertFileSrc } from '@tauri-apps/api/core';
import type { PermissionRequiredEvent } from '@ema-agent/permission';
import type { AskUserRequiredEvent } from '@ema-agent/tools';
import type { AppEvent } from '@ema-agent/server/sse/eventHub.js';
import type { ThemeSettings } from '@ema-agent/server/composition/settings/themeSetting.js';
import type { EventDisplayTable } from '../api/settings.js';

// ── 对外类型 ────────────────────────────────────────────────────────────────

export type SubWindowName = 'chat' | 'settings';

export interface DesktopSettingsPayload {
  readonly permissionTimeoutMs: number | null;
  readonly eventDisplay: EventDisplayTable | null;
}

type DecisionRequiredEvent = PermissionRequiredEvent | AskUserRequiredEvent;

export type TerminalEvent =
  | { readonly type: 'output'; readonly data: readonly number[] }
  | { readonly type: 'exit'; readonly exitCode: number | null };

export interface OpenTerminalInput {
  readonly terminalId: string;
  readonly sessionId: string;
  readonly cwd?: string;
  readonly shellExecutable?: string;
  readonly columns: number;
  readonly rows: number;
  readonly onEvent: (event: TerminalEvent) => void;
}

export type TerminalShellKind =
  | 'powerShell'
  | 'commandPrompt'
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'wsl'
  | 'sh';

export interface DetectedTerminalShell {
  readonly label: string;
  readonly kind: TerminalShellKind;
  readonly executablePath: string;
}

export interface BrowserBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type BrowserEvent =
  | { readonly type: 'loading'; readonly browserId: string; readonly loading: boolean }
  | { readonly type: 'locationChanged'; readonly browserId: string; readonly url: string }
  | { readonly type: 'titleChanged'; readonly browserId: string; readonly title: string };

// ── Tauri 环境检测 ─────────────────────────────────────────────────────────

let _detected: boolean | null = null;

function detectTauri(): boolean {
  if (_detected !== null) return _detected;
  try {
    _detected = '__TAURI_INTERNALS__' in window;
  } catch {
    _detected = false;
  }
  if (!_detected) {
    console.debug('[tauri-bridge] plain browser mode');
  }
  return _detected;
}

// ── 懒加载导入 ──────────────────────────────────────────────────────────────

type TauriCore   = typeof import('@tauri-apps/api/core');
type TauriEvent  = typeof import('@tauri-apps/api/event');
type TauriDialog = typeof import('@tauri-apps/plugin-dialog');
type TauriWindow = typeof import('@tauri-apps/api/window');

let _core:   TauriCore   | null = null;
let _event:  TauriEvent  | null = null;
let _dialog: TauriDialog | null = null;
let _window: TauriWindow | null = null;
const terminalChannels = new Map<string, object>();

const WINDOW_VISIBILITY_EVENT = 'ema://window-visibility';
const SYSTEM_EVENT = 'ema://system-event';
const SUB_WINDOW_OPENED_EVENT = 'ui:window-opened';
const SUB_WINDOW_CLOSED_EVENT = 'ui:window-closed';
const THEME_CHANGED_EVENT = 'theme:changed';
const DESKTOP_SETTINGS_CHANGED_EVENT = 'settings:desktop-changed';
const SPEECH_STARTED_EVENT = 'speech:start';
const SPEECH_DELTA_EVENT = 'speech:delta';
const SPEECH_ENDED_EVENT = 'speech:end';
const DECISION_REQUIRED_EVENT = 'decision:push';
const DECISION_DISMISSED_EVENT = 'decision:dismiss';
const STAGE_EMOTION_EVENT = 'stage:emotion-changed';
const STAGE_MOTION_EVENT = 'stage:motion-changed';
const STAGE_SPEECH_EVENT = 'stage:speech-state';
const STAGE_CYCLE_EXPRESSION_EVENT = 'stage:cycle-expression';
const BROWSER_EVENT = 'browser:event';

async function getCore(): Promise<TauriCore | null> {
  if (!detectTauri()) return null;
  if (_core) return _core;
  try {
    _core = await import('@tauri-apps/api/core');
    return _core;
  } catch (cause) {
    throw new Error('Tauri Core 加载失败，桌面命令不可用', { cause });
  }
}

async function getEvent(): Promise<TauriEvent | null> {
  if (!detectTauri()) return null;
  if (_event) return _event;
  try {
    _event = await import('@tauri-apps/api/event');
    return _event;
  } catch (cause) {
    throw new Error('Tauri Event 加载失败，跨窗口事件不可用', { cause });
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

// ── 具体实现 ────────────────────────────────────────────────────────────────

export const tauriBridge = {
  isTauri: detectTauri,

  convertFileSrc(filePath: string): string {
    return detectTauri() ? tauriConvertFileSrc(filePath) : filePath;
  },

  async setWindowTheme(mode: 'light' | 'dark'): Promise<void> {
    const winMod = await getWindow();
    if (!winMod) return;
    await winMod.getCurrentWindow().setTheme(mode).catch(() => {});
  },

  async isWindowVisible(): Promise<boolean | null> {
    const winMod = await getWindow();
    if (!winMod) return null;
    return winMod.getCurrentWindow().isVisible().catch(() => null);
  },

  async listenWindowVisibility(handler: (visible: boolean) => void): Promise<() => void> {
    return listenTauri<{ visible: boolean }>(WINDOW_VISIBILITY_EVENT, ({ visible }) => handler(visible));
  },

  async publishSystemEvent(event: AppEvent): Promise<void> {
    await emitTauri(SYSTEM_EVENT, event);
  },

  async listenSystemEvents(handler: (event: AppEvent) => void): Promise<() => void> {
    return listenTauri(SYSTEM_EVENT, handler);
  },

  async publishSubWindowOpened(name: SubWindowName): Promise<void> {
    await emitTauri(SUB_WINDOW_OPENED_EVENT, { name });
  },

  async publishSubWindowClosed(name: SubWindowName): Promise<void> {
    await emitTauri(SUB_WINDOW_CLOSED_EVENT, { name });
  },

  async listenSubWindowOpened(handler: (name: SubWindowName) => void): Promise<() => void> {
    return listenTauri<{ name: SubWindowName }>(SUB_WINDOW_OPENED_EVENT, ({ name }) => handler(name));
  },

  async listenSubWindowClosed(handler: (name: SubWindowName) => void): Promise<() => void> {
    return listenTauri<{ name: SubWindowName }>(SUB_WINDOW_CLOSED_EVENT, ({ name }) => handler(name));
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

  async publishSpeechStarted(sessionId: string): Promise<void> {
    await emitTauri(SPEECH_STARTED_EVENT, { sessionId });
  },

  async publishSpeechDelta(sessionId: string, text: string): Promise<void> {
    await emitTauri(SPEECH_DELTA_EVENT, { sessionId, text });
  },

  async publishSpeechEnded(sessionId: string): Promise<void> {
    await emitTauri(SPEECH_ENDED_EVENT, { sessionId });
  },

  async listenSpeechStarted(handler: (sessionId: string) => void): Promise<() => void> {
    return listenTauri<{ sessionId: string }>(SPEECH_STARTED_EVENT, ({ sessionId }) => handler(sessionId));
  },

  async listenSpeechDelta(
    handler: (sessionId: string, text: string) => void,
  ): Promise<() => void> {
    return listenTauri<{ sessionId: string; text: string }>(
      SPEECH_DELTA_EVENT,
      ({ sessionId, text }) => handler(sessionId, text),
    );
  },

  async listenSpeechEnded(handler: (sessionId: string) => void): Promise<() => void> {
    return listenTauri<{ sessionId: string }>(SPEECH_ENDED_EVENT, ({ sessionId }) => handler(sessionId));
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

  async publishStageEmotion(emotion: string, stageId?: string): Promise<void> {
    await emitTauri(STAGE_EMOTION_EVENT, { emotion, ...(stageId ? { stageId } : {}) });
  },

  async publishStageMotion(motion: string, stageId?: string): Promise<void> {
    await emitTauri(STAGE_MOTION_EVENT, { motion, ...(stageId ? { stageId } : {}) });
  },

  async publishStageSpeech(speaking: boolean, rms: number, stageId?: string): Promise<void> {
    await emitTauri(STAGE_SPEECH_EVENT, { speaking, rms, ...(stageId ? { stageId } : {}) });
  },

  async requestStageExpressionCycle(stageId?: string): Promise<void> {
    await emitTauri(STAGE_CYCLE_EXPRESSION_EVENT, stageId ? { stageId } : undefined);
  },

  async listenStageEmotion(
    handler: (emotion: string, stageId?: string) => void,
  ): Promise<() => void> {
    return listenTauri<{ emotion: string; stageId?: string }>(
      STAGE_EMOTION_EVENT,
      ({ emotion, stageId }) => handler(emotion, stageId),
    );
  },

  async listenStageMotion(
    handler: (motion: string, stageId?: string) => void,
  ): Promise<() => void> {
    return listenTauri<{ motion: string; stageId?: string }>(
      STAGE_MOTION_EVENT,
      ({ motion, stageId }) => handler(motion, stageId),
    );
  },

  async listenStageSpeech(
    handler: (speaking: boolean, rms: number, stageId?: string) => void,
  ): Promise<() => void> {
    return listenTauri<{ speaking: boolean; rms: number; stageId?: string }>(
      STAGE_SPEECH_EVENT,
      ({ speaking, rms, stageId }) => handler(speaking, rms, stageId),
    );
  },

  async listenStageExpressionCycle(handler: (stageId?: string) => void): Promise<() => void> {
    return listenTauri<{ stageId?: string }>(
      STAGE_CYCLE_EXPRESSION_EVENT,
      ({ stageId }) => handler(stageId),
    );
  },

  async openChatWindow(): Promise<void> {
    await invokeTauri('open_window', { label: 'chat' });
  },

  async openSettingsWindow(): Promise<void> {
    await invokeTauri('open_window', { label: 'settings' });
  },

  async getStartNarrativeOnLaunch(): Promise<boolean> {
    return (await invokeTauri<boolean>('get_start_narrative_on_launch')) ?? true;
  },

  async setStartNarrativeOnLaunch(value: boolean): Promise<void> {
    await invokeTauri('set_start_narrative_on_launch', { value });
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
    if (!core) return;
    await core.invoke('set_passthrough', { value });
  },

  async startDragging(): Promise<void> {
    const winMod = await getWindow();
    if (!winMod) return;
    await winMod.getCurrentWindow().startDragging();
  },

  async cursorAndBounds() {
    const winMod = await getWindow();
    if (!winMod) return null;
    const w = winMod.getCurrentWindow();
    const [cursor, pos, size, scale] = await Promise.all([
      winMod.cursorPosition(),
      w.outerPosition(),
      w.outerSize(),
      w.scaleFactor(),
    ]);
    return {
      cursor: { x: cursor.x, y: cursor.y },
      win:    { x: pos.x, y: pos.y, width: size.width, height: size.height },
      scale,
    };
  },

  async getServerSecret(): Promise<string | null> {
    return invokeTauri<string>('get_server_secret');
  },

  async getServerPort(): Promise<number | null> {
    return invokeTauri<number>('get_server_port');
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
    // 如果底层意外返回单个结果，则统一包装成单元素数组；取消选择则返回 []
    return result ? [result as string] : [];
  },

  async openUrl(url: string): Promise<void> {
    // Tauri 2：调用 plugin:opener|open_url（需要在 tauri.conf.json 中配置 @tauri-apps/plugin-opener）。
    // 如果插件不可用，则退化为 window.open；Tauri WebView 会将其交给系统浏览器处理。
    const core = await getCore();
    if (core) {
      try {
        await core.invoke('plugin:opener|open_url', { url });
        return;
      } catch { /* 插件未配置——继续执行后面的降级逻辑 */ }
    }
    window.open(url, '_blank');
  },

  /** 在系统文件管理器中定位路径(后台进程日志目录等);插件缺失时抛错由调用方提示。 */
  async revealInFolder(path: string): Promise<void> {
    const core = await getCore();
    if (!core) throw new Error('当前环境不支持文件管理器定位');
    await core.invoke('plugin:opener|reveal_item_in_dir', { paths: [path] });
  },

  /** 用系统默认方式打开路径本身(KB 库目录等);失败抛错由调用方提示。 */
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
        ...(input.shellExecutable ? { shellExecutable: input.shellExecutable } : {}),
        columns: input.columns,
        rows: input.rows,
        onEvent: channel,
      });
    } catch (error) {
      terminalChannels.delete(input.terminalId);
      throw error;
    }
  },

  async listTerminalShells(): Promise<readonly DetectedTerminalShell[]> {
    return (await invokeTauri<DetectedTerminalShell[]>('list_terminal_shells')) ?? [];
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
    const core = await getCore();
    if (!core) throw new Error('当前环境不支持内置浏览器');
    await core.invoke('open_browser', { browserId, url, bounds });
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
    const core = await getCore();
    if (!core) return;
    await core.invoke('set_browser_visible', { browserId, visible });
  },

  async closeBrowser(browserId: string): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('close_browser', { browserId });
  },

  async listenBrowserEvents(handler: (event: BrowserEvent) => void): Promise<() => void> {
    return listenTauri(BROWSER_EVENT, handler);
  },
};
