import { Hono } from 'hono';
import { z }    from 'zod';
import type { AppBindings } from '../wiring/index.js';

// ── Route factory ─────────────────────────────────────────────────────────────

export function agentTasksRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // ── GET /api/agent-tasks ───────────────────────────────────────────────────
  //
  // List tasks for a session (most-recent first).
  // Optional `status` query param filters by a single status value.
  // Both root tasks and subagent tasks are returned; use parentId to build
  // a tree view on the frontend.
  app.get('/', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);

    const status = c.req.query('status');
    let tasks = bindings.taskStore.listForSession(sessionId);
    if (status) tasks = tasks.filter(t => t.status === status);

    return c.json({ tasks });
  });

  // ── GET /api/agent-tasks/:taskId ──────────────────────────────────────────
  app.get('/:taskId', (c) => {
    const task = bindings.taskStore.get(c.req.param('taskId'));
    if (!task) return c.json({ error: 'not_found' }, 404);
    return c.json({ task });
  });

  // ── DELETE /api/agent-tasks/:taskId ───────────────────────────────────────
  //
  // Cancel the task if still running, then hard-delete from the DB.
  // agent_task_messages are removed automatically via ON DELETE CASCADE.
  app.delete('/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    const task   = bindings.taskStore.get(taskId);
    if (!task) return c.json({ error: 'not_found' }, 404);

    if (task.status === 'running') {
      bindings.taskStore.cancel(taskId, 'user_deleted');
    }
    bindings.taskStore.delete(taskId);

    return c.json({ ok: true });
  });

  // ── POST /api/agent-tasks/clear ───────────────────────────────────────────
  //
  // Batch-delete all terminal tasks (completed/failed/cancelled) for a session.
  app.post('/clear', async (c) => {
    const parsed = z.object({ sessionId: z.string() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'sessionId is required' }, 400);

    const deleted = bindings.taskStore.clearTerminalForSession(parsed.data.sessionId);
    return c.json({ deleted });
  });

  // ── GET /api/agent-tasks/:taskId/messages ─────────────────────────────────
  //
  // Subagent conversation transcript (assistant text, tool calls, tool results)
  // in chronological order. Each message has a `role` and a `content` object
  // whose shape varies by role:
  //
  //   assistant   → { text: string }
  //   tool_call   → { callId, name, args, iteration }
  //   tool_result → { callId, name, excerpt, isError, error?, durationMs }
  app.get('/:taskId/messages', (c) => {
    const taskId = c.req.param('taskId');
    if (!bindings.taskStore.get(taskId)) return c.json({ error: 'not_found' }, 404);

    const rows = bindings.agentTaskMessages.listForTask(taskId);
    const messages = rows.map(r => ({
      id:        r.id,
      taskId:    r.task_id,
      role:      r.role,
      content:   JSON.parse(r.content_json) as unknown,
      createdAt: r.created_at,
    }));

    return c.json({ messages });
  });

  return app;
}
