// 让 xterm 实例跨 Dock 重挂与 Session 切换继续存在，并把输入输出接到同一个 PTY。
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';

import { tauriBridge, type TerminalEvent } from '../../../../lib/tauri-bridge.js';
import { settingsApi } from '../../../../api/settings.js';
import { systemApi } from '../../../../api/system.js';

type TerminalStatus = 'running' | 'exited';

interface TerminalEntry {
  readonly sessionId: string;
  readonly terminal: Terminal;
  readonly fit: FitAddon;
  readonly listeners: Set<() => void>;
  status: TerminalStatus;
  exitCode: number | null;
  columns: number;
  rows: number;
  opened: boolean;
}

const entries = new Map<string, TerminalEntry>();

// xterm 自绘文字和底色, CSS 只能改外壳. 底色交给窗口材质, 前景与 ANSI 仍由主题明确提供.
function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string): string => style.getPropertyValue(name).trim();
  const foreground = color('--ema-text-primary');
  const red = color('--ema-danger-text');
  const green = color('--ema-success-text');
  const yellow = color('--ema-warning-text');
  const blue = color('--ema-syntax-key');
  const magenta = color('--ema-violet-text');
  const cyan = color('--ema-info-text');
  return {
    background: '#00000000',
    foreground,
    cursor: foreground,
    cursorAccent: color('--ema-material-fill'),
    selectionBackground: color('--ema-primary-muted'),
    black: foreground,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: color('--ema-text-secondary'),
    brightBlack: color('--ema-text-tertiary'),
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: foreground,
  };
}

export interface StartTerminalInput {
  readonly terminalId: string;
  readonly sessionId: string;
  readonly cwd: string;
}

export async function startTerminal(input: StartTerminalInput): Promise<void> {
  if (entries.has(input.terminalId)) return;
  // 偏好存 kind:解不出(未设/该 kind 已消失)回退探测首条,与设置页"自动选择"同义;
  // 探测全空则不传 shell,由 Rust 落平台默认 shell。
  const shellSetting = await settingsApi.getValue('frontend.terminal.shellExecutable');
  const preferredKind = typeof shellSetting.value === 'string' ? shellSetting.value.trim() : '';
  const { shells } = await systemApi.findTerminalShells();
  const shell = (preferredKind
    ? shells.find(candidate => candidate.kind === preferredKind)
    : undefined) ?? shells[0];
  const terminal = new Terminal({
    allowTransparency: true,
    cursorBlink: true,
    convertEol: false,
    fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace',
    fontSize: 13,
    scrollback: 10_000,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(new WebLinksAddon((_event, url) => void tauriBridge.openUrl(url)));
  const entry: TerminalEntry = {
    sessionId: input.sessionId,
    terminal,
    fit,
    listeners: new Set(),
    status: 'running',
    exitCode: null,
    columns: 80,
    rows: 24,
    opened: false,
  };
  entries.set(input.terminalId, entry);
  terminal.onData((data) => void tauriBridge.writeTerminal(input.terminalId, data));

  try {
    await tauriBridge.openTerminal({
      terminalId: input.terminalId,
      sessionId: input.sessionId,
      cwd: input.cwd,
      ...(shell ? { shell: { kind: shell.kind, path: shell.path } } : {}),
      columns: entry.columns,
      rows: entry.rows,
      onEvent: (event) => acceptTerminalEvent(input.terminalId, event),
    });
  } catch (error) {
    entries.delete(input.terminalId);
    terminal.dispose();
    throw error;
  }
}

export function attachTerminal(terminalId: string, element: HTMLElement): void {
  const entry = requireTerminal(terminalId);
  entry.terminal.options.theme = terminalTheme();
  if (!entry.opened) {
    entry.terminal.open(element);
    entry.opened = true;
  } else if (entry.terminal.element && entry.terminal.element.parentElement !== element) {
    element.replaceChildren(entry.terminal.element);
  }
  fitTerminal(terminalId);
  entry.terminal.focus();
}

export function updateTerminalTheme(terminalId: string): void {
  const entry = entries.get(terminalId);
  if (entry) entry.terminal.options.theme = terminalTheme();
}

export function fitTerminal(terminalId: string): void {
  const entry = entries.get(terminalId);
  if (!entry?.opened || entry.status !== 'running') return;
  entry.fit.fit();
  if (entry.terminal.cols === entry.columns && entry.terminal.rows === entry.rows) return;
  entry.columns = entry.terminal.cols;
  entry.rows = entry.terminal.rows;
  void tauriBridge.resizeTerminal(terminalId, entry.columns, entry.rows);
}

export function terminalState(terminalId: string): { status: TerminalStatus; exitCode: number | null } {
  const entry = entries.get(terminalId);
  return entry
    ? { status: entry.status, exitCode: entry.exitCode }
    : { status: 'exited', exitCode: null };
}

export function subscribeTerminal(terminalId: string, listener: () => void): () => void {
  const entry = entries.get(terminalId);
  if (!entry) return () => {};
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

export async function closeTerminalSession(terminalId: string): Promise<void> {
  const entry = entries.get(terminalId);
  entries.delete(terminalId);
  try {
    await tauriBridge.closeTerminal(terminalId);
  } finally {
    entry?.terminal.dispose();
  }
}

export async function closeSessionTerminals(sessionId: string): Promise<void> {
  const owned = [...entries.entries()].filter(([, entry]) => entry.sessionId === sessionId);
  for (const [terminalId, entry] of owned) {
    entries.delete(terminalId);
    entry.terminal.dispose();
  }
  await tauriBridge.closeSessionTerminals(sessionId);
}

function acceptTerminalEvent(terminalId: string, event: TerminalEvent): void {
  const entry = entries.get(terminalId);
  if (!entry) return;
  if (event.type === 'output') {
    entry.terminal.write(Uint8Array.from(event.data));
    return;
  }
  entry.status = 'exited';
  entry.exitCode = event.exitCode;
  for (const listener of entry.listeners) listener();
}

function requireTerminal(terminalId: string): TerminalEntry {
  const entry = entries.get(terminalId);
  if (!entry) throw new Error('终端会话不存在');
  return entry;
}
