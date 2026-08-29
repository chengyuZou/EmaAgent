// 让 xterm 实例跨 Dock 重挂与 Session 切换继续存在，并把输入输出接到同一个 PTY。
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

import { tauriBridge, type TerminalEvent } from '../../../../lib/tauri-bridge.js';
import { settingsApi } from '../../../../api/settings.js';

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

export interface StartTerminalInput {
  readonly terminalId: string;
  readonly sessionId: string;
  readonly cwd?: string;
}

export async function startTerminal(input: StartTerminalInput): Promise<void> {
  if (entries.has(input.terminalId)) return;
  const shellSetting = await settingsApi.getValue('frontend.terminal.shellExecutable');
  const shellExecutable = typeof shellSetting.value === 'string' && shellSetting.value.trim()
    ? shellSetting.value
    : undefined;
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace',
    fontSize: 13,
    scrollback: 10_000,
    theme: {
      background: '#151515',
      foreground: '#d8d8d8',
      cursor: '#d8d8d8',
      selectionBackground: '#4a4a4a',
    },
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
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(shellExecutable ? { shellExecutable } : {}),
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
  if (!entry.opened) {
    entry.terminal.open(element);
    entry.opened = true;
  } else if (entry.terminal.element && entry.terminal.element.parentElement !== element) {
    element.replaceChildren(entry.terminal.element);
  }
  fitTerminal(terminalId);
  entry.terminal.focus();
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
