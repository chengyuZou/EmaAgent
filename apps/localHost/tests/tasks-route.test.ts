// 验证 Task HTTP 边界只返回当前 Session 的持久快照，不复制修改语义。

import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asTaskId, asTurnId } from '@ema-agent/ids';
import type { Task } from '@ema-agent/tasks';
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

type RouteTaskStore = Parameters<typeof tasksRoute>[0];

function createTaskStore(
  overrides: Partial<RouteTaskStore> = {},
): RouteTaskStore {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => undefined),
    toSnapshot: (value) => ({
      ...value,
      blocks: [...value.blocks],
      blockedBy: [...value.blockedBy],
    }),
    ...overrides,
  };
}

describe('Task 快照路由', () => {
  it('按 Session 列出 TaskSnapshot', async () => {
    const list = vi.fn(() => [task]);
    const app = tasksRoute(
      createTaskStore({
        list,
      }),
    );

    const response = await app.request('/?sessionId=session-route');

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(asSessionId('session-route'));
    expect(await response.json()).toEqual({
      tasks: [expect.objectContaining({ id: task.id, displayNumber: 1 })],
    });
  });

  it('查询不存在或其他 Session 的 Task 时返回 404', async () => {
    const app = tasksRoute(
      createTaskStore({
        get: vi.fn(() => undefined),
      }),
    );

    const response = await app.request('/task-route?sessionId=another-session');

    expect(response.status).toBe(404);
  });
});
