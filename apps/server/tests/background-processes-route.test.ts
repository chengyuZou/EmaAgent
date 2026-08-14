// 测试后台进程 Route 的 Session 隔离、增量输出和停止请求契约。

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  asBackgroundProcessId,
  asSessionId,
} from '@ema-agent/ids';
import type { BackgroundProcessPort } from '@ema-agent/tools';
import { backgroundProcessesRoute } from '../src/routes/backgroundProcesses.js';

const sessionId = asSessionId('00000000-0000-4000-8000-000000000011');
const processId = asBackgroundProcessId('00000000-0000-4000-8000-000000000012');

describe('backgroundProcessesRoute', () => {
  it('按 Session 列表并透传有界筛选', async () => {
    const port = createPort();
    const app = mount(port);
    const response = await app.request(
      `/api/background-processes?sessionId=${sessionId}&status=running&limit=5`,
    );

    expect(response.status).toBe(200);
    expect(port.list).toHaveBeenCalledWith(sessionId, {
      status: 'running',
      limit: 5,
    });
  });

  it('其他 Session 的进程统一返回 404，不泄露存在性', async () => {
    const port = createPort();
    port.readOutput.mockRejectedValue(
      new Error('Background process not found in the current Session'),
    );
    const app = mount(port);
    const response = await app.request(
      `/api/background-processes/${processId}/output?sessionId=${sessionId}`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('停止请求只把 Session 与进程身份交给业务端口', async () => {
    const port = createPort();
    const app = mount(port);
    const response = await app.request(
      `/api/background-processes/${processId}/stop`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      },
    );

    expect(response.status).toBe(200);
    expect(port.stop).toHaveBeenCalledWith(sessionId, processId);
  });

  it('路径里的进程身份不是 UUID 时在 Route 层拒绝', async () => {
    const port = createPort();
    const app = mount(port);
    const response = await app.request(
      `/api/background-processes/not-a-process/output?sessionId=${sessionId}`,
    );

    expect(response.status).toBe(400);
    expect(port.readOutput).not.toHaveBeenCalled();
  });
});

function mount(port: ReturnType<typeof createPort>): Hono {
  const app = new Hono();
  app.route('/api/background-processes', backgroundProcessesRoute(port));
  return app;
}

function createPort() {
  const summary = {
    id: processId,
    sessionId,
    command: 'echo ready',
    cwd: 'D:/workspace',
    status: 'running' as const,
    createdAt: 1,
    durationMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    outputTruncated: false,
  };
  return {
    runCommand: vi.fn<BackgroundProcessPort['runCommand']>(),
    list: vi.fn<BackgroundProcessPort['list']>(() => [summary]),
    readOutput: vi.fn<BackgroundProcessPort['readOutput']>(async () => ({
      process: summary,
      stdout: '',
      stderr: '',
      nextCursor: '',
      hasMore: false,
    })),
    stop: vi.fn<BackgroundProcessPort['stop']>(() => summary),
  };
}
