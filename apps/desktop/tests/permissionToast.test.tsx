// @vitest-environment jsdom
// 桌宠不显示 AskUser, 但必须保留其 FIFO 占位; 另一 Session 仍可以独立批准.
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequiredEvent } from '@ema-agent/permission';
import type { AskUserRequiredEvent } from '@ema-agent/tools';
import type { PendingInteraction } from '@ema-agent/turn';
import { PendingInteractionView } from '../src/chat/interactions/PendingInteractionView.js';
import { PermissionToastLayer } from '../src/stage/PermissionToastLayer.js';
import { DEFAULT_WALLPAPER_SETTINGS } from '@ema-agent/server/settings/wallpaperCatalog.js';

vi.mock('../src/api/settings.js', () => ({ settingsApi: {
  getValue: async () => ({ value: DEFAULT_WALLPAPER_SETTINGS }),
} }));

const bridge = vi.hoisted(() => ({ required: undefined as undefined | ((event: PermissionRequiredEvent | AskUserRequiredEvent) => void),
  dismissed: undefined as undefined | ((id: string) => void), respond: vi.fn(async () => undefined) }));
const pending = vi.hoisted(() => ({ entry: undefined as PendingInteraction | undefined }));
vi.mock('../src/stores/chatNavigation.js', () => ({
  useChatNavigationStore: (selector: (state: { viewedSessionId: string }) => unknown) =>
    selector({ viewedSessionId: 'session' }),
}));
vi.mock('../src/stores/sessionActivity.js', () => ({
  useSessionActivityStore: (selector: (state: {
    bySession: Map<string, { pendingInteractions: PendingInteraction[] }>;
  }) => unknown) => selector({
    bySession: new Map([['session', { pendingInteractions: pending.entry ? [pending.entry] : [] }]]),
  }),
}));
vi.mock('../src/lib/tauri-bridge.js', () => ({ tauriBridge: {
  listenDecisionRequired: async (fn: typeof bridge.required) => { bridge.required = fn; return () => {}; },
  listenDecisionDismissed: async (fn: typeof bridge.dismissed) => { bridge.dismissed = fn; return () => {}; },
} }));
vi.mock('../src/api/sessionWebSocket.js', () => ({ SessionRequestError: class extends Error {},
  sessionWebSocket: { respondPermission: bridge.respond } }));
vi.mock('@ema-agent/ui', () => ({
  Button: ({ children, onClick, disabled }: {
    children: ReactNode; onClick(): void; disabled?: boolean;
  }) => createElement('button', { onClick, disabled }, children),
  Card: ({ children }: { children: ReactNode }) => createElement('div', {}, children),
  IconButton: ({ label }: { label: string }) => createElement('button', {}, label),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  bridge.respond.mockClear();
  pending.entry = undefined;
});

describe('桌宠 Session FIFO', () => {
  it('AskUser 未解决时不能跳到后面的子代理批准, 回复不再带 turnId', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(PermissionToastLayer)));
    const permission: PermissionRequiredEvent = { type: 'permission_required', sessionId: 'session', turnId: 'ended',
      subagentId: 'child', runId: 'run', toolCallId: 'child-call', toolName: 'PowerShell', input: {} };
    await act(async () => {
      bridge.required!({ type: 'ask_user_required', sessionId: 'session', turnId: 'ended', toolCallId: 'ask', questions: [] });
      bridge.required!(permission);
      bridge.required!({ ...permission, sessionId: 'other', toolCallId: 'other-call' });
    });
    expect(host.querySelectorAll('[data-pet-interactive]')).toHaveLength(1);
    await act(async () => bridge.dismissed!('ask'));
    expect(host.querySelectorAll('[data-pet-interactive]')).toHaveLength(2);
    expect(host.textContent).toContain('子代理');
    const allow = [...host.querySelectorAll('button')].find(button => button.textContent === '允许')!;
    await act(async () => allow.click());
    expect(bridge.respond).toHaveBeenCalledWith('session', 'child-call', { action: 'allow' });
    await act(async () => root.unmount());
    host.remove();
  });

  it('桌宠此会话按钮不需要规则字段, 仅提交 allowSession', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(PermissionToastLayer)));
      await act(async () => bridge.required!({
        type: 'permission_required', sessionId: 'session', turnId: 'turn',
        toolCallId: 'session-call', toolName: 'WebSearch', input: { query: 'x' },
      }));
      const button = [...host.querySelectorAll('button')].find(item => item.textContent === '此会话');
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(bridge.respond).toHaveBeenCalledWith('session', 'session-call', { action: 'allowSession' });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('聊天批准卡无规则字段时仍显示本会话允许, 仅提交 allowSession', async () => {
    pending.entry = {
      kind: 'permission', createdAt: 1, toolCallId: 'chat-call',
      request: {
        sessionId: 'session', turnId: 'turn', toolCallId: 'chat-call',
        toolName: 'WebSearch', input: { query: 'x' },
      },
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(PendingInteractionView)));
      const button = [...host.querySelectorAll('button')].find(item => item.textContent === '本会话允许');
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(bridge.respond).toHaveBeenCalledWith('session', 'chat-call', { action: 'allowSession' });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
