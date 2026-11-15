import { describe, expect, it, vi } from 'vitest';
import {
  McpServerConflictError,
  McpServerNotFoundError,
  McpUnsupportedTransportError,
} from '@ema-agent/mcp';
import { mcpServersRoute, type McpServersRouteDeps } from '../src/routes/mcp/servers.js';

describe('MCP servers routes', () => {
  it('启用保存完成之前不返回成功', async () => {
    let finish!: () => void;
    const setEnabled = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const mcp = { setEnabled } as unknown as McpServersRouteDeps['mcp'];
    const app = mcpServersRoute({ mcp });
    let responded = false;
    const response = app.request('/servers/local/enable', { method: 'PUT' }).then(value => {
      responded = true;
      return value;
    });
    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith('local', true));
    expect(responded).toBe(false);
    finish();
    expect((await response).status).toBe(200);
  });

  it('启用失败交给路由错误处理, 不返回成功或产生无人处理的拒绝', async () => {
    const failure = new Error('settings write failed');
    const mcp = { setEnabled: vi.fn().mockRejectedValue(failure) } as unknown as McpServersRouteDeps['mcp'];
    const handled: Error[] = [];
    const app = mcpServersRoute({ mcp }).onError((error, context) => {
      handled.push(error);
      return context.json({ error: 'internal_error' }, 500);
    });
    expect((await app.request('/servers/local/enable', { method: 'PUT' })).status).toBe(500);
    expect(handled).toEqual([failure]);
  });

  it('创建与更新区分 201 / 409 / 404 并传递 authType', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce('srv-1')
      .mockRejectedValueOnce(new McpServerConflictError('notion'));
    const update = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new McpServerNotFoundError('missing'));
    const app = mcpServersRoute({
      mcp: { create, update } as unknown as McpServersRouteDeps['mcp'],
    });

    const invalidNameRes = await app.request('/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad name!', config: { type: 'http', url: 'https://mcp.notion.com/mcp' } }),
    });
    expect(invalidNameRes.status).toBe(400);

    const createRes = await app.request('/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'notion',
        config: { type: 'http', url: 'https://mcp.notion.com/mcp' },
        authType: 'oauth',
      }),
    });
    expect(createRes.status).toBe(201);
    await expect(createRes.json()).resolves.toEqual({ id: 'srv-1' });
    expect(create).toHaveBeenCalledWith(
      'notion',
      { type: 'http', url: 'https://mcp.notion.com/mcp' },
      undefined,
      'oauth',
    );

    const conflictRes = await app.request('/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'notion',
        config: { type: 'http', url: 'https://mcp.notion.com/mcp' },
      }),
    });
    expect(conflictRes.status).toBe(409);

    const updateRes = await app.request('/servers/notion', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { type: 'http', url: 'https://mcp.notion.com/v2/mcp' },
        authType: 'oauth',
      }),
    });
    expect(updateRes.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      'notion',
      { type: 'http', url: 'https://mcp.notion.com/v2/mcp' },
      undefined,
      'oauth',
    );

    const missingUpdateRes = await app.request('/servers/missing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { type: 'http', url: 'https://mcp.notion.com/mcp' },
      }),
    });
    expect(missingUpdateRes.status).toBe(404);
  });

  it('connect 校验服务器存在与启用状态, OAuth 端点正确映射正常与异常状态码', async () => {
    const getServer = vi.fn((name: string) => {
      if (name === 'disabled-srv') return { enabled: false };
      if (name === 'enabled-srv') return { enabled: true };
      return null;
    });
    const connect = vi.fn().mockResolvedValue({});
    const startOAuth = vi.fn()
      .mockResolvedValueOnce({ authorizationUrl: 'https://mcp.notion.com/authorize' })
      .mockRejectedValueOnce(new McpUnsupportedTransportError('OAuth is only supported for HTTP servers.'))
      .mockRejectedValueOnce(new McpServerNotFoundError('missing'));
    const cancelOAuth = vi.fn().mockResolvedValue(undefined);
    const clearOAuthTokens = vi.fn().mockResolvedValue(undefined);

    const app = mcpServersRoute({
      mcp: {
        getServer,
        connect,
        startOAuth,
        cancelOAuth,
        clearOAuthTokens,
      } as unknown as McpServersRouteDeps['mcp'],
    });

    expect((await app.request('/servers/missing/connect', { method: 'POST' })).status).toBe(404);

    const disabledRes = await app.request('/servers/disabled-srv/connect', { method: 'POST' });
    expect(disabledRes.status).toBe(400);
    await expect(disabledRes.json()).resolves.toMatchObject({ error: 'server_disabled' });

    const connectRes = await app.request('/servers/enabled-srv/connect', { method: 'POST' });
    expect(connectRes.status).toBe(200);
    expect(connect).toHaveBeenCalledWith('enabled-srv');

    const startRes = await app.request('/servers/enabled-srv/oauth/start', { method: 'POST' });
    expect(startRes.status).toBe(200);
    await expect(startRes.json()).resolves.toEqual({ authorizationUrl: 'https://mcp.notion.com/authorize' });

    expect((await app.request('/servers/stdio-srv/oauth/start', { method: 'POST' })).status).toBe(400);
    expect((await app.request('/servers/missing/oauth/start', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/servers/enabled-srv/oauth/cancel', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/servers/enabled-srv/oauth/tokens', { method: 'DELETE' })).status).toBe(200);
    expect(cancelOAuth).toHaveBeenCalledWith('enabled-srv');
    expect(clearOAuthTokens).toHaveBeenCalledWith('enabled-srv');
  });
});
