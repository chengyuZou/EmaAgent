import { describe, expect, it, vi } from 'vitest';
import { mcpServersRoute, type McpServersRouteDeps } from '../src/routes/mcp/servers.js';

describe('MCP enable route', () => {
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
});
