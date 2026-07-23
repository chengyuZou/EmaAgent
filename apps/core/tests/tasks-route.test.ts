// 验证 Task HTTP 边界只返回当前 Session 的持久快照，不复制修改语义。

import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asTaskId, asTurnId } from '@ema-agent/ids';
import type { Task } from '@ema-agent/tasks';
import type { AppBindings } from '../src/wiring/index.js';
import { tasksRoute } from '../src/routes/tasks.js';

const task: Task = {
  id: asTaskId('task-route'),
  sessionId: asSessionId('session-route'),
  displayNumber: 1,
  subject: 'Route task',
  description: 'Restore this snapshot',
  status: 'pending',
  blocks: [],
  blockedBy: [],
  createdByTurnId: asTurnId('turn-route'),
  version: 0,
  createdAt: 1,
  updatedAt: 1,
};

describe('Task 快照路由', () => {
  it('按 Session 列出 TaskSnapshot', async () => {
    const list = vi.fn(() => [task]);
    const app = tasksRoute({
      taskStore: {
        list,
        toSnapshot: (value: Task) => value,
      },
    } as unknown as AppBindings);

    const response = await app.request('/?sessionId=session-route');

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(asSessionId('session-route'));
    expect(await response.json()).toEqual({
      tasks: [expect.objectContaining({ id: task.id, displayNumber: 1 })],
    });
  });

  it('查询不存在或其他 Session 的 Task 时返回 404', async () => {
    const app = tasksRoute({
      taskStore: {
        get: vi.fn(() => undefined),
      },
    } as unknown as AppBindings);

    const response = await app.request('/task-route?sessionId=another-session');

    expect(response.status).toBe(404);
  });
});
