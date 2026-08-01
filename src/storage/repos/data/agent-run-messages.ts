// AgentRun 转录按单调序号保存子 Agent 的输出、推理和工具活动。

import { randomUUID } from 'node:crypto';
import type { AgentRunId } from '@ema-agent/ids';
import type { SqliteDb } from '../../database/database.js';

export type AgentRunMessageRole =
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning'
  | 'coordinator';

export interface AgentRunMessageRow {
  id: string;
  agent_run_id: AgentRunId;
  role: AgentRunMessageRole;
  content_json: string;
  sequence: number;
  created_at: number;
}

export interface AgentRunMessageInsert {
  agentRunId: AgentRunId;
  role: AgentRunMessageRole;
  content: unknown;
  createdAt: number;
}

export class AgentRunMessageSerializationError extends Error {
  readonly code = 'storage/agent-run-message-serialization-failed';

  constructor(
    readonly agentRunId: AgentRunId,
    readonly role: AgentRunMessageRole,
    cause?: unknown,
  ) {
    super(
      `Agent run message content cannot be serialized: run=${agentRunId}, role=${role}`,
      { cause },
    );
    this.name = 'AgentRunMessageSerializationError';
  }
}

function serializeContent(message: AgentRunMessageInsert): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(message.content);
  } catch (error) {
    throw new AgentRunMessageSerializationError(
      message.agentRunId,
      message.role,
      error,
    );
  }
  if (serialized === undefined) {
    throw new AgentRunMessageSerializationError(
      message.agentRunId,
      message.role,
      new TypeError('JSON.stringify returned undefined'),
    );
  }
  return serialized;
}

export class AgentRunMessagesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(message: AgentRunMessageInsert): void {
    const contentJson = serializeContent(message);
    this.db.prepare(
      `INSERT INTO agent_run_messages (
         id, agent_run_id, role, content_json, sequence, created_at
       )
       SELECT ?, ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?
       FROM agent_run_messages
       WHERE agent_run_id = ?`,
    ).run(
      randomUUID(),
      message.agentRunId,
      message.role,
      contentJson,
      message.createdAt,
      message.agentRunId,
    );
  }

  listForRun(agentRunId: AgentRunId): AgentRunMessageRow[] {
    return this.db.prepare(
      `SELECT * FROM agent_run_messages
       WHERE agent_run_id = ?
       ORDER BY sequence ASC`,
    ).all(agentRunId) as AgentRunMessageRow[];
  }
}
