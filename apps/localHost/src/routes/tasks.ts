// 提供 Task 重启恢复所需的只读快照，修改仍统一经过根 Turn 的 Task 工具。

import { Hono } from 'hono';
import { asSessionId, asTaskId } from '@ema-agent/ids';
import type { AppBindings } from '../wiring/index.js';

export function tasksRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

    const tasks = bindings.taskStore
      .list(asSessionId(sessionId))
      .map((task) => bindings.taskStore.toSnapshot(task));
    return c.json({ tasks });
  });

  app.get('/:taskId', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

    const task = bindings.taskStore.get(
      asSessionId(sessionId),
      asTaskId(c.req.param('taskId')),
    );
    return task
      ? c.json({ task: bindings.taskStore.toSnapshot(task) })
      : c.json({ error: 'not_found' }, 404);
  });

  return app;
}
