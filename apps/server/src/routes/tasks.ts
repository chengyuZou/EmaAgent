// 提供 Task 重启恢复所需的只读快照，修改仍统一经过根 Turn 的 Task 工具。

import { Hono } from 'hono';
import { z } from 'zod';
import type { TaskStore } from '@ema-agent/tasks';
import { queryValidator } from './validate.js';

type TaskRouteStore = Pick<TaskStore, 'get' | 'list'>;

const sessionQuery = z.object({
  sessionId: z.string().min(1),
});

export const tasksRoute = (taskStore: TaskRouteStore) =>
  new Hono()
    .get('/', queryValidator(sessionQuery), context => {
      const { sessionId } = context.req.valid('query');
      return context.json({ tasks: taskStore.list(sessionId) });
    })
    .get('/:taskId', queryValidator(sessionQuery), context => {
      const { sessionId } = context.req.valid('query');
      const task = taskStore.get(sessionId, context.req.param('taskId'));
      return task
        ? context.json({ task })
        : context.json({ error: 'not_found' }, 404);
    });
