import type { SqliteDb } from '../database.js';
import { randomUUID } from 'node:crypto';

// ── 类型─────────────────────────────────────────────────────────────────────

export type AgentTaskMessageRole = 'assistant' | 'tool_call' | 'tool_result' | 'reasoning';

export interface AgentTaskMessageRow {
  id:           string;
  task_id:      string;
  role:         AgentTaskMessageRole;
  content_json: string;
  sequence:     number;
  created_at:   number;
}

export interface AgentTaskMessageInsert {
  taskId:    string;
  role:      AgentTaskMessageRole;
  content:   unknown;  // 序列化为 content_json
  createdAt: number;
}

export class AgentTaskMessageSerializationError extends Error {
  readonly code = 'storage/agent-task-message-serialization-failed';

  constructor(
    readonly taskId: string,
    readonly role: AgentTaskMessageRole,
    cause?: unknown,
  ) {
    super(
      `Agent task message content cannot be serialized: task=${taskId}, role=${role}`,
      { cause },
    );
    this.name = 'AgentTaskMessageSerializationError';
  }
}

function serializeContent(m: AgentTaskMessageInsert): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(m.content);
  } catch (error) {
    throw new AgentTaskMessageSerializationError(m.taskId, m.role, error);
  }
  if (serialized === undefined) {
    throw new AgentTaskMessageSerializationError(
      m.taskId,
      m.role,
      new TypeError('JSON.stringify returned undefined'),
    );
  }
  return serialized;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * 存储 subagent 运行产生的对话 transcript。
 *
 * 仅由 SSE fan-out 层 (turns.ts) 写入，engine 不直接写。
 * schema 通过 ON DELETE CASCADE 关联 agent_tasks，删除 task 时
 * 自动删除其 message。
 *
 * 各 role 的 content_json 结构：
 *   assistant   — { text: string }
 *   tool_call   — { callId, name, args, iteration }
 *   tool_result — { callId, name, excerpt, isError, error?, durationMs }
 */
export class AgentTaskMessagesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(m: AgentTaskMessageInsert): void {
    const contentJson = serializeContent(m);
    this.db
      .prepare(
        `INSERT INTO agent_task_messages
           (id, task_id, role, content_json, sequence, created_at)
         SELECT ?, ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?
           FROM agent_task_messages
          WHERE task_id = ?`,
      )
      .run(randomUUID(), m.taskId, m.role, contentJson, m.createdAt, m.taskId);
  }

  listForTask(taskId: string): AgentTaskMessageRow[] {
    return this.db
      .prepare(
        'SELECT * FROM agent_task_messages WHERE task_id = ? ORDER BY sequence ASC',
      )
      .all(taskId) as AgentTaskMessageRow[];
  }
}
