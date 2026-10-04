// @vitest-environment jsdom
// 桌宠不显示 AskUser, 但必须保留其 FIFO 占位; 另一 Session 仍可以独立批准.
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequiredEvent } from '@ema-agent/permission';
import type { AskUserRequiredEvent } from '@ema-agent/tools';
import { PermissionToastLayer } from '../src/stage/PermissionToastLayer.js';

const bridge = vi.hoisted(() => ({ required: undefined as undefined | ((event: PermissionRequiredEvent | AskUserRequiredEvent) => void),
  dismissed: undefined as undefined | ((id: string) => void), respond: vi.fn(async () => undefined) }));
vi.mock('../src/lib/tauri-bridge.js', () => ({ tauriBridge: {
  listenDecisionRequired: async (fn: typeof bridge.required) => { bridge.required = fn; return () => {}; },
  listenDecisionDismissed: async (fn: typeof bridge.dismissed) => { bridge.dismissed = fn; return () => {}; },
} }));
vi.mock('../src/api/sessionWebSocket.js', () => ({ SessionRequestError: class extends Error {},
  sessionWebSocket: { respondPermission: bridge.respond } }));
vi.mock('@ema-agent/ui', () => ({ Button: ({ children, onClick, disabled }: {
  children: ReactNode; onClick(): void; disabled?: boolean;
}) => createElement('button', { onClick, disabled }, children) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => { bridge.respond.mockClear(); });

describe('桌宠 Session FIFO', () => {
  it('AskUser 未解决时不能跳到后面的子代理批准, 回复不再带 turnId', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(PermissionToastLayer)));
    const permission: PermissionRequiredEvent = { type: 'permission_required', sessionId: 'session', turnId: 'ended',
      subagentId: 'child', runId: 'run', toolCallId: 'child-call', toolName: 'PowerShell', input: {}, reason: '确认' };
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
});
