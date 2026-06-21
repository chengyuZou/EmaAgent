import type { SqliteDb } from '../database.js';
import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentTaskMessageRole = 'assistant' | 'tool_call' | 'tool_result';

export interface AgentTaskMessageRow {
  id:           string;
  task_id:      string;
  role:         AgentTaskMessageRole;
  content_json: string;
  created_at:   number;
}

export interface AgentTaskMessageInsert {
  taskId:    string;
  role:      AgentTaskMessageRole;
  content:   unknown;  // serialised to content_json
  createdAt: number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Stores the conversation transcript produced by a subagent run.
 *
 * Written exclusively by the SSE fan-out layer (turns.ts), never by the engine.
 * The schema enforces ON DELETE CASCADE from agent_tasks so deleting a task
 * automatically removes its messages.
 *
 * content_json shape by role:
 *   assistant   — { text: string }
 *   tool_call   — { callId, name, args, iteration }
 *   tool_result — { callId, name, excerpt, isError, error?, durationMs }
 */
export class AgentTaskMessagesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(m: AgentTaskMessageInsert): void {
    this.db
      .prepare(
        `INSERT INTO agent_task_messages (id, task_id, role, content_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), m.taskId, m.role, JSON.stringify(m.content), m.createdAt);
  }

  listForTask(taskId: string): AgentTaskMessageRow[] {
    return this.db
      .prepare(
        'SELECT * FROM agent_task_messages WHERE task_id = ? ORDER BY created_at ASC',
      )
      .all(taskId) as AgentTaskMessageRow[];
  }
}
