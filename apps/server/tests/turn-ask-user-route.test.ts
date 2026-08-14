// 测试 AskUser HTTP 响应校验和专属取消入口。

import { Hono } from 'hono';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { registerAskUserRoutes } from '../src/routes/turns/askUser.js';

function createApp() {
  const interactionQueue = {
    listPending: vi.fn(() => []),
    respondAskUser: vi.fn(() => true),
    cancelAskUser: vi.fn(() => true),
  };
  const app = new Hono();
  registerAskUserRoutes(app, interactionQueue);
  return { app, interactionQueue };
}

describe('AskUser Turn 路由', () => {
  it('回答必须是字符串字典', async () => {
    const { app, interactionQueue } = createApp();
    const response = await app.request('/turn-1/ask-user/prompt-1/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: ['not', 'a', 'record'] }),
    });

    expect(response.status).toBe(400);
    expect(interactionQueue.respondAskUser).not.toHaveBeenCalled();
  });

  it('取消只调用 AskUser 专属入口', async () => {
    const { app, interactionQueue } = createApp();
    const response = await app.request('/turn-1/ask-user/prompt-1/cancel', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(interactionQueue.cancelAskUser).toHaveBeenCalledWith(
      'prompt-1',
      'cancelled by user',
      'turn-1',
    );
  });
});

