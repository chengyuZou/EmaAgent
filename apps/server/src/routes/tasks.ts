// 提供 Task 重启恢复所需的只读快照，修改仍统一经过根 Turn 的 Task 工具。

import { Hono } from 'hono';
import type { TaskStore } from '@ema-agent/tasks';

type TaskRouteStore = Pick<TaskStore, 'get' | 'list'>;

export function tasksRoute(taskStore: TaskRouteStore): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

    const tasks = taskStore.list(sessionId);
    return c.json({ tasks });
  });

  app.get('/:taskId', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

    const task = taskStore.get(
      sessionId,
      c.req.param('taskId'),
    );
    return task
      ? c.json({ task })
      : c.json({ error: 'not_found' }, 404);
  });

  return app;
}
