// 测试 Permission 审批身份核对和永久规则 CRUD HTTP 契约。
import { describe, expect, it, vi } from 'vitest';
import type { AppBindings } from '../src/wiring/index.js';
import { permissionRoute } from '../src/routes/permission.js';

function createApp() {
  const rules = [{
    id: 'rule-1',
    action: 'ask' as const,
    tool: 'bash',
    scope: 'global' as const,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }];
  const permission = {
    getRules: vi.fn(() => rules),
    addRule: vi.fn((rule) => ({ ...rule, id: 'rule-2', enabled: true, createdAt: 2, updatedAt: 2 })),
    setRuleEnabled: vi.fn(),
    removeRule: vi.fn((id: string) => id === 'rule-1'),
  };
  const interactionQueue = {
    respondPermission: vi.fn(() => true),
    cancelPermission: vi.fn(() => true),
    listPending: vi.fn(() => []),
  };
  return {
    app: permissionRoute({ permission, interactionQueue } as unknown as AppBindings),
    permission,
    interactionQueue,
  };
}

describe('Permission 路由', () => {
  it('审批响应同时传递 turnId 与 promptId', async () => {
    const { app, interactionQueue } = createApp();
    const response = await app.request('/turn-1/prompt-1/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    });

    expect(response.status).toBe(200);
    expect(interactionQueue.respondPermission).toHaveBeenCalledWith(
      'prompt-1',
      { action: 'allow' },
      'turn-1',
    );
  });

  it('取消只调用 Permission 专属入口', async () => {
    const { app, interactionQueue } = createApp();
    const response = await app.request('/turn-1/prompt-1/cancel', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(interactionQueue.cancelPermission).toHaveBeenCalledWith(
      'prompt-1',
      'cancelled by user',
      'turn-1',
    );
  });

  it('规则支持列出、新增、启停和删除', async () => {
    const { app, permission } = createApp();
    expect((await app.request('/rules')).status).toBe(200);

    const created = await app.request('/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'allow', tool: 'file_read', scope: 'global' }),
    });
    expect(created.status).toBe(201);
    expect(permission.addRule).toHaveBeenCalledWith({
      action: 'allow',
      tool: 'file_read',
      scope: 'global',
      workspaceRoot: undefined,
    });

    expect((await app.request('/rules/rule-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })).status).toBe(200);
    expect(permission.setRuleEnabled).toHaveBeenCalledWith('rule-1', false);

    expect((await app.request('/rules/rule-1', { method: 'DELETE' })).status).toBe(200);
    expect(permission.removeRule).toHaveBeenCalledWith('rule-1');
  });

  it('工作区规则拒绝相对 workspaceRoot', async () => {
    const { app, permission } = createApp();
    const response = await app.request('/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'deny',
        tool: '*',
        scope: 'workspace',
        workspaceRoot: './relative',
      }),
    });

    expect(response.status).toBe(400);
    expect(permission.addRule).not.toHaveBeenCalled();
  });
});
