// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@ema-agent/ui';
import { witchTrialCharacterNames } from '@ema-agent/narrative/isWitchTrialCharacter';
import { SandboxStatusSettings } from '../src/settings/security/SandboxStatusSettings.js';
import { TerminalShellSettings } from '../src/settings/security/TerminalShellSettings.js';
import { CharacterGridPage } from '../src/settings/character/CharacterGridPage.js';
import { SessionProjectMenu } from '../src/chat/session/sessionProjectMenu.js';
import { InputProjectBar } from '../src/chat/input/inputProjectBar.js';
import { useCharacterStore } from '../src/stores/character.js';
import { useSessionStore } from '../src/stores/session.js';
import { useMainNavigationStore } from '../src/layout/navigation.js';
import type { Project, SessionListItem } from '../src/api/sessions.js';

const api = vi.hoisted(() => ({
  sandbox: vi.fn(),
  shells: vi.fn(),
  getSetting: vi.fn(),
  addSession: vi.fn(),
  removeSession: vi.fn(),
  loadSessions: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../src/api/system.js', () => ({ systemApi: {
  getSandboxStatus: api.sandbox,
  findTerminalShells: api.shells,
} }));
vi.mock('../src/api/settings.js', () => ({ settingsApi: { getValue: api.getSetting } }));
vi.mock('../src/api/workspaces.js', () => ({ projectsApi: {
  addSession: api.addSession,
  removeSession: api.removeSession,
} }));
vi.mock('../src/lib/notifications/toast.js', () => ({ showToast: api.toast }));

const session: SessionListItem = {
  id: 'session-a', title: 'Existing chat', cwd: 'C:/original', projectId: 'project-a',
  createdAt: 1, updatedAt: 1, lastActivityAt: 1, archivedAt: null, pinned: false,
  forkedFromSessionId: null, forkedFromTurnId: null, permissionMode: 'default',
  ttsEnabled: false, providerId: null, modelId: null, reasoningEffort: 'off',
  lastViewedAt: null, hasActiveTurn: false, lastTurnStatus: null, hasUnread: false,
};
const projects: Project[] = ['a', 'b'].map(id => ({
  id: `project-${id}`, name: `Project ${id}`, pinned: false, createdAt: 1, updatedAt: 1,
  folders: [{ path: `C:/${id}`, isPrimary: true, createdAt: 1, updatedAt: 1 }], sessions: [],
}));

let root: Root;
let host: HTMLDivElement;

async function render(children: ReactNode): Promise<void> {
  await act(async () => root.render(<TooltipProvider>{children}</TooltipProvider>));
}

function button(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label || item.getAttribute('aria-label') === label);
  if (!element) throw new Error(`Button not found: ${label}`);
  return element;
}

async function chooseProject(label: string): Promise<void> {
  await act(async () => button('切换会话项目').dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true,
  })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(element => element.textContent === label);
  expect(item).toBeDefined();
  await act(async () => item!.click());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  api.sandbox.mockResolvedValue({
    backend: 'unisolated', bashMode: 'disabled', networkAccess: 'none',
    warning: 'WSL 启动检查未通过.', warningDetails: '完整诊断输出\n第二行',
  });
  api.shells.mockResolvedValue({ shells: [
    { kind: 'powershell', label: 'Windows PowerShell', path: 'C:/Windows/powershell.exe' },
  ] });
  api.getSetting.mockResolvedValue({ value: '', apply: 'immediate' });
  api.addSession.mockResolvedValue(undefined);
  api.removeSession.mockResolvedValue(undefined);
  api.loadSessions.mockResolvedValue(undefined);
  useCharacterStore.setState({ characters: [], loading: false, load: async () => {} });
  useSessionStore.setState({
    error: null, loadSessions: api.loadSessions,
    sessions: { pinned: [], recent: [session], pinnedProjects: [], projects, byId: new Map([[session.id, session]]) },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('settings and project interactions with shared UI components', () => {
  it('keeps full warning output collapsed and preserves the element for closing animation', async () => {
    await render(<SandboxStatusSettings />);
    const trigger = button('查看详情');
    expect(trigger.className).toContain('focus-ring');
    const details = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    expect(details.getAttribute('aria-hidden')).toBe('true');
    expect(details.style.gridTemplateRows).toBe('0fr');
    await act(async () => trigger.click());
    expect(details.style.gridTemplateRows).toBe('1fr');
    expect(details.textContent).toContain('完整诊断输出\n第二行');
    await act(async () => button('收起详情').click());
    expect(details.isConnected).toBe(true);
    expect(details.style.gridTemplateRows).toBe('0fr');
    expect(details.getAttribute('aria-hidden')).toBe('true');
  });

  it('opens the shared Dialog and renders the exported full names as table rows', async () => {
    await render(<CharacterGridPage onOpen={() => {}} />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button('魔法少女的魔女审判角色全名名单').click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.className).toContain('ema-anim-dialog');
    const rows = dialog.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(witchTrialCharacterNames.length);
    for (const [index, names] of witchTrialCharacterNames.entries()) {
      expect(rows[index]!.querySelector('th')!.textContent).toBe(names[0]);
      for (const alias of names.slice(1)) expect(rows[index]!.textContent).toContain(alias);
    }
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button('魔法少女的魔女审判角色全名名单').getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('keeps the automatic shell label short and shows the actual detected path separately', async () => {
    await render(<TerminalShellSettings />);
    const select = document.querySelector('[role="combobox"]')!;
    expect(select.textContent).toBe('自动选择');
    expect(select.className).toContain('whitespace-nowrap');
    expect(select.className).toContain('w-60');
    expect(host.textContent).toContain('自动选择: Windows PowerShell - C:/Windows/powershell.exe');
  });

  it('moves an existing Session from the Header menu without sending a cwd update', async () => {
    await render(<SessionProjectMenu session={session} />);
    await chooseProject('Project b');
    expect(api.addSession).toHaveBeenCalledWith('project-b', { sessionId: 'session-a' });
    expect(api.removeSession).not.toHaveBeenCalled();
    expect(api.loadSessions).toHaveBeenCalledOnce();
    expect(session.cwd).toBe('C:/original');
  });

  it('removes project membership and reports a refresh failure as saved, not as a failed write', async () => {
    api.loadSessions.mockImplementation(async () => useSessionStore.setState({ error: 'Offline' }));
    await render(<SessionProjectMenu session={session} />);
    await chooseProject('不在项目中工作');
    expect(api.removeSession).toHaveBeenCalledWith('project-a', 'session-a');
    expect(api.toast).toHaveBeenCalledWith('项目归属已保存, 但列表刷新失败: Offline', { variant: 'warning' });
  });

  it('reports a rejected membership write without claiming it was saved', async () => {
    api.addSession.mockRejectedValueOnce(new Error('Offline'));
    await render(<SessionProjectMenu session={session} />);
    await chooseProject('Project b');
    expect(api.loadSessions).not.toHaveBeenCalled();
    expect(api.toast).toHaveBeenCalledWith('切换项目失败: Offline', { variant: 'danger' });
    expect(button('切换会话项目').disabled).toBe(false);
  });

  it('shows project and cwd selection for a new conversation without writing an existing Session', async () => {
    useMainNavigationStore.getState().openNewSession('project-a');
    await render(<InputProjectBar projectId="project-a" />);
    expect(host.querySelector<HTMLInputElement>('#new-session-cwd')!.value).toBe('C:/a');
    expect(api.addSession).not.toHaveBeenCalled();
    expect(api.removeSession).not.toHaveBeenCalled();
  });
});
