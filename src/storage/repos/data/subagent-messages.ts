// 保存子代理自己的 Message, 按 sequence 分页读取, 不混入根 Session 消息.
import type { SqliteDb } from '../../database/database.js';
import type { MessageRole } from './messages.js';

// 普通子代理自身不产生 reminder, 但 fork 继承的父对话历史可能包含它
export type SubagentMessageKind = 'normal' | 'tool_results' | 'summary' | 'continuation' | 'reminder'; 

export interface SubagentMessageRow {
  id: string;
  subagent_id: string;
  role: MessageRole;
  kind: SubagentMessageKind;
  blocks_json: string;
  interrupted: number;
  sequence: number;
  created_at: number;
  summarized_through_message_id: string | null;
}

export interface SubagentMessageInsert {
  id: string;
  subagentId: string;
  role: MessageRole;
  kind?: SubagentMessageKind;
  blocksJson: string;
  interrupted?: boolean;
  createdAt: number;
  summarizedThroughMessageId?: string;
}

export interface SubagentMessagePage {
  rows: SubagentMessageRow[];
  nextCursor: number | null;
}

export class SubagentMessagesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(message: SubagentMessageInsert): void {
    this.db.prepare(
      `INSERT INTO subagent_messages (
         id, subagent_id, role, kind, blocks_json, interrupted, sequence, created_at,
         summarized_through_message_id
       )
       SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?
       FROM subagent_messages
       WHERE subagent_id = ?`,
    ).run(
      message.id,
      message.subagentId,
      message.role,
      message.kind ?? 'normal',
      message.blocksJson,
      message.interrupted ? 1 : 0,
      message.createdAt,
      message.summarizedThroughMessageId ?? null,
      message.subagentId,
    );
  }

  updateBlocks(id: string, blocksJson: string): void {
    this.db.prepare(
      'UPDATE subagent_messages SET blocks_json = ? WHERE id = ?',
    ).run(blocksJson, id);
  }

  markInterrupted(id: string): void {
    this.db.prepare(
      'UPDATE subagent_messages SET interrupted = 1 WHERE id = ?',
    ).run(id);
  }

  listPage(subagentId: string, beforeSequence: number | undefined, limit = 50): SubagentMessagePage {
    const pageSize = Math.min(Math.max(limit, 1), 100);
    const rows = this.db.prepare(
      `SELECT id, subagent_id, role, kind, blocks_json, interrupted, sequence, created_at,
              summarized_through_message_id
         FROM subagent_messages
        WHERE subagent_id = ?
          AND (? IS NULL OR sequence < ?)
        ORDER BY sequence DESC
        LIMIT ?`,
    ).all(
      subagentId,
      beforeSequence ?? null,
      beforeSequence ?? null,
      pageSize + 1,
    ) as SubagentMessageRow[];
    const pageRows = rows.slice(0, pageSize);
    const nextCursor = rows.length > pageSize
      ? pageRows[pageRows.length - 1]?.sequence ?? null
      : null;
    return {
      rows: pageRows.reverse(),
      nextCursor,
    };
  }

  listAllForSubagent(subagentId: string): SubagentMessageRow[] {
    return this.db.prepare(
      `SELECT id, subagent_id, role, kind, blocks_json, interrupted, sequence, created_at,
              summarized_through_message_id
         FROM subagent_messages
        WHERE subagent_id = ?
        ORDER BY sequence ASC`,
    ).all(subagentId) as SubagentMessageRow[];
  }
}
