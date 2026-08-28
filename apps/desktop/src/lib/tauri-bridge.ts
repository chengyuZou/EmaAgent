/**
 * Tauri 桥接层——所有 Tauri IPC 通信的唯一统一入口。
 *
 * 所有 `@tauri-apps/api/*` 的导入都集中在这里。
 * `apps/desktop/src` 中的其他文件都不允许直接导入 `@tauri-apps/api`。
 * 这样可以为普通浏览器环境提供降级方案，使 Ladle stories
 * 和单元测试即使没有 Tauri 运行时也能正常渲染。
 */

// ── 对外接口 ────────────────────────────────────────────────────────────────

export interface TauriBridge {
  /** 调用一个 Rust command；如果当前没有 Tauri 运行时，则返回 `null`。 */
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null>;

  /** 发送一个跨窗口事件；如果当前没有 Tauri 运行时，则什么也不做。 */
  emit(eventName: string, payload?: unknown): Promise<void>;

  /**
   * 监听跨窗口事件，并返回一个取消监听函数。
   * 如果当前没有 Tauri 运行时，则返回一个什么也不做的取消监听函数。
   */
  listen<T>(eventName: string, handler: (event: { payload: T }) => void): Promise<() => void>;

  /** 当前是否存在可用的 Tauri 运行时。 */
  isTauri(): boolean;

  /** 获取服务端启动时生成的共享密钥；浏览器模式下返回 null。 */
  getServerSecret(): Promise<string | null>;

  /** 获取本机服务绑定的 loopback（回环地址）端口；浏览器模式下返回 null。 */
  getServerPort(): Promise<number | null>;

  /** 根据 label 显示或聚焦一个预先声明好的子窗口（例如 chat / settings）。 */
  openWindow(label: string): Promise<void>;

  /** 退出整个应用。 */
  quit(): Promise<void>;

  /** 设置当前窗口是否始终置顶。 */
  setAlwaysOnTop(value: boolean): Promise<void>;

  /** 设置当前窗口是否启用鼠标穿透。 */
  setPassthrough(value: boolean): Promise<void>;

  /** 开始原生窗口拖拽；必须在 mousedown 事件处理函数中调用。 */
  startDragging(): Promise<void>;

  /**
   * 获取全局鼠标位置和当前窗口边界，单位均为物理像素。
   * 动态鼠标穿透循环会轮询这些信息——即使窗口当前忽略鼠标事件也能工作，
   * 因为 cursorPosition 获取的是操作系统级全局鼠标位置，而不是窗口事件。
   * 如果当前没有 Tauri 运行时，则返回 null。
   */
  cursorAndBounds(): Promise<{
    cursor: { x: number; y: number };
    win:    { x: number; y: number; width: number; height: number };
    scale:  number;
  } | null>;

  /**
   * 打开原生“另存为”对话框，并从 defaultPath 指定的位置开始。
   * 返回用户选择的绝对路径；如果用户取消则返回 null。
   * 如果当前没有 Tauri 运行时（浏览器 / Ladle 开发模式），也返回 null。
   */
  saveFileDialog(opts?: {
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<string | null>;

  /**
   * 打开原生“打开文件”（或目录）对话框，仅允许单选。
   * 返回选中文件/目录的绝对路径；如果用户取消则返回 null。
   * 如果当前没有 Tauri 运行时（浏览器 / Ladle 开发模式），也返回 null。
   */
  openFileDialog(opts?: {
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    /** 为 true 时打开目录选择器，而不是文件选择器。 */
    directory?: boolean;
  }): Promise<string | null>;

  /**
   * 打开支持多选的原生“打开文件”对话框。
   * 返回所有选中文件的绝对路径；如果用户取消则返回空数组。
   * 如果当前没有 Tauri 运行时（浏览器 / Ladle 开发模式），也返回 []。
   */
  openFileDialogMultiple(opts?: {
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<string[]>;

  /**
   * 使用系统默认浏览器打开 URL。
   * 优先使用 Tauri 的 plugin:opener；不可用时退化为 window.open。
   */
  openUrl(url: string): Promise<void>;

  /** 在系统文件管理器中定位一个本机路径。 */
  revealInFolder(path: string): Promise<void>;
}

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
type TauriWebview = typeof import('@tauri-apps/api/webview');

let _core:   TauriCore   | null = null;
let _event:  TauriEvent  | null = null;
let _dialog: TauriDialog | null = null;
let _window: TauriWindow | null = null;
let _webview: TauriWebview | null = null;

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

async function getWebview(): Promise<TauriWebview | null> {
  if (!detectTauri()) return null;
  if (_webview) return _webview;
  try {
    _webview = await import('@tauri-apps/api/webview');
    return _webview;
  } catch {
    return null;
  }
}

// ── 具体实现 ────────────────────────────────────────────────────────────────

export const tauriBridge: TauriBridge = {
  isTauri: detectTauri,

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    const core = await getCore();
    if (!core) return null;
    return core.invoke<T>(cmd, args);
  },

  async emit(eventName: string, payload?: unknown): Promise<void> {
    const event = await getEvent();
    if (!event) return;
    await event.emit(eventName, payload);
  },

  async listen<T>(
    eventName: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void> {
    const event = await getEvent();
    if (!event) return () => {};
    const unlisten = await event.listen<T>(eventName, handler);
    return () => unlisten();
  },

  async openWindow(label: string): Promise<void> {
    const core = await getCore();
    if (!core) return;
    await core.invoke('open_window', { label });
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
    return tauriBridge.invoke<string>('get_server_secret');
  },

  async getServerPort(): Promise<number | null> {
    return tauriBridge.invoke<number>('get_server_port');
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
};
