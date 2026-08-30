// AgentRun 转录按单调序号保存子 Agent 的输出、推理和工具活动。

import { randomUUID } from 'node:crypto';
import type { SqliteDb } from '../../database/database.js';

export type AgentRunMessageRole =
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning';

export interface AgentRunMessageRow {
  id: string;
  agent_run_id: string;
  role: AgentRunMessageRole;
  block_index: number | null;
  content_json: string;
  sequence: number;
  created_at: number;
}

export interface AgentRunMessageInsert {
  agentRunId: string;
  role: AgentRunMessageRole;
  content: unknown;
  createdAt: number;
}

/** 块级 upsert：同一 (run, role, blockIndex) 只保留一行，内容随流式增长被整体重写。 */
export interface AgentRunBlockUpsert {
  agentRunId: string;
  role: 'assistant' | 'reasoning' | 'tool_call';
  blockIndex: number;
  content: unknown;
  createdAt: number;
}

export class AgentRunMessageSerializationError extends Error {
  readonly code = 'storage/agent-run-message-serialization-failed';

  constructor(
    readonly agentRunId: string,
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

  /**
   * 块级 upsert：首次到达建行并取得 sequence，之后同一块的流式增长只重写 content_json。
   * tool_result 不走这里——它一次调用一行、block_index 为 NULL。
   */
  upsertBlock(message: AgentRunBlockUpsert): void {
    const contentJson = serializeContent(message);
    this.db.prepare(
      `INSERT INTO agent_run_messages (
         id, agent_run_id, role, block_index, content_json, sequence, created_at
       )
       SELECT ?, ?, ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?
       FROM agent_run_messages
       WHERE agent_run_id = ?
       ON CONFLICT(agent_run_id, role, block_index)
       DO UPDATE SET content_json = excluded.content_json`,
    ).run(
      randomUUID(),
      message.agentRunId,
      message.role,
      message.blockIndex,
      contentJson,
      message.createdAt,
      message.agentRunId,
    );
  }

  listForRun(agentRunId: string): AgentRunMessageRow[] {
    return this.db.prepare(
      `SELECT * FROM agent_run_messages
       WHERE agent_run_id = ?
       ORDER BY sequence ASC`,
    ).all(agentRunId) as AgentRunMessageRow[];
  }
}
