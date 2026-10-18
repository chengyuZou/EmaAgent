// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeSessionFromChat } from '../src/chat/session/removeSessionFromChat.js';
import { startTerminal, closeTerminalSession } from '../src/chat/sidePanel/tabs/terminal/terminalSessions.js';
import { sessionsApi } from '../src/api/sessions.js';
import { useSessionAttachmentStore } from '../src/stores/sessionAttachment.js';
import { useSessionPanelStore } from '../src/stores/sessionPanel.js';

const native = vi.hoisted(() => ({
  openTerminal: vi.fn(async () => {}),
  closeTerminal: vi.fn(async () => {}),
  closeSessionTerminals: vi.fn(async () => {}),
  dispose: vi.fn(),
}));

vi.mock('../src/lib/tauri/tauriBridge.js', () => ({ tauriBridge: native }));
vi.mock('../src/api/settings.js', () => ({
  settingsApi: { getValue: vi.fn(async () => ({ value: null })) },
}));
vi.mock('../src/api/system.js', () => ({
  systemApi: { findTerminalShells: vi.fn(async () => ({ shells: [] })) },
}));
vi.mock('../src/api/sessions.js', () => ({
  sessionsApi: { listAttachments: vi.fn() },
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon(): void {}
    onData(): void {}
    dispose = native.dispose;
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('../src/chat/session/sessionSubscriptions.js', () => ({
  removeSessionSubscription: vi.fn(),
}));
vi.mock('../src/chat/speech/turnSpeechPlayback.js', () => ({
  removeSessionPlayback: vi.fn(),
}));
vi.mock('../src/chat/speech/turnSpeechGeneration.js', () => ({
  removeSessionSpeechGeneration: vi.fn(),
}));

afterEach(async () => {
  await closeTerminalSession('terminal-a');
  await closeTerminalSession('terminal-b');
  useSessionAttachmentStore.getState().evictSession('session-a');
  useSessionAttachmentStore.getState().evictSession('session-b');
  useSessionPanelStore.setState({ layouts: {} });
  vi.clearAllMocks();
});

describe('removeSessionFromChat', () => {
  it('cleans the removed session terminals and attachments without changing another session', async () => {
    await startTerminal({ terminalId: 'terminal-a', sessionId: 'session-a', cwd: 'C:/a' });
    await startTerminal({ terminalId: 'terminal-b', sessionId: 'session-b', cwd: 'C:/b' });
    const attachments = useSessionAttachmentStore.getState();
    vi.mocked(sessionsApi.listAttachments).mockResolvedValue({ attachments: [] });
    await attachments.loadForSession('session-a');
    await attachments.loadForSession('session-b');
    const panels = useSessionPanelStore.getState();
    panels.openTab('session-a', { id: 'terminal:terminal-a', kind: 'terminal', terminalId: 'terminal-a' });
    panels.openTab('session-b', { id: 'terminal:terminal-b', kind: 'terminal', terminalId: 'terminal-b' });

    removeSessionFromChat('session-a');

    expect(native.closeSessionTerminals).toHaveBeenCalledTimes(1);
    expect(native.closeSessionTerminals).toHaveBeenCalledWith('session-a');
    expect(native.dispose).toHaveBeenCalledTimes(1);
    expect(useSessionPanelStore.getState().layouts['session-a']).toBeUndefined();
    expect(useSessionPanelStore.getState().layouts['session-b']).toBeDefined();
    expect(useSessionAttachmentStore.getState().bySession.has('session-a')).toBe(false);
    expect(useSessionAttachmentStore.getState().loadStateBySession.has('session-a')).toBe(false);
    expect(useSessionAttachmentStore.getState().bySession.has('session-b')).toBe(true);
  });

  it('does not restore attachment state when an earlier request returns after removal', async () => {
    let complete!: (result: Awaited<ReturnType<typeof sessionsApi.listAttachments>>) => void;
    vi.mocked(sessionsApi.listAttachments).mockImplementationOnce(() => new Promise(resolve => {
      complete = resolve;
    }));
    const pending = useSessionAttachmentStore.getState().loadForSession('session-a');

    removeSessionFromChat('session-a');
    complete({ attachments: [] });
    await pending;

    expect(useSessionAttachmentStore.getState().bySession.has('session-a')).toBe(false);
    expect(useSessionAttachmentStore.getState().loadStateBySession.has('session-a')).toBe(false);
  });
});
