// 汇总 data.db 与单个 Session 的可展示统计，不承担备份、恢复或业务写入。
// 同表指标一次扫描取全(条件聚合),不做"每指标一次子查询"的重复扫描。
import type { SqliteDb } from '../../database/database.js';

export interface DataDirStats {
  sessionCount: number;
  turnCount: number;
  messageCount: number;
  taskCount: number;
  agentRunCount: number;
  toolExecutionCount: number;
  backgroundProcessCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** attachment_images + attachment_pasted_texts 两本账合计。 */
  attachmentCount: number;
  attachmentTotalBytes: number;
  visionDescriptionCount: number;
  visionDescriptionBytes: number;
  audioCount: number;
  audioDurationMs: number;
}

export interface SessionStats {
  turnCount: number;
  messageCount: number;
  taskCount: number;
  agentRunCount: number;
  toolExecutionCount: number;
  backgroundProcessCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  chatTurns: number;
  workTurns: number;
  narrativeAlwaysTurns: number;
  audioTurnCount: number;
  audioTotalBytes: number;
  audioTotalDurationMs: number;
  attachmentCount: number;
  attachmentTotalBytes: number;
}

interface CountRow { c: number }
interface CountBytesRow { c: number; b: number }

export class DataDirStatsRepo {
  constructor(private readonly db: SqliteDb) {}

  getStats(): DataDirStats {
    // 不同表各一次 COUNT 是物理下限;COUNT(*) 走 OP_Count 只数条目不解码行。
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as CountRow).c;
    const countBytes = (table: string): CountBytesRow =>
      this.db.prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(byte_size), 0) AS b FROM ${table}`,
      ).get() as CountBytesRow;

    const images = countBytes('attachment_images');
    const pasted = countBytes('attachment_pasted_texts');
    const vision = countBytes('attachment_vision_descriptions_caches');
    const speechOutputs = this.db.prepare(`
      SELECT COUNT(*) AS c, COALESCE(SUM(duration_ms), 0) AS d
        FROM speech_outputs
    `).get() as { c: number; d: number };
    const tokens = this.db.prepare(`
      SELECT COALESCE(SUM(usage_input_tokens), 0)  AS i,
             COALESCE(SUM(usage_output_tokens), 0) AS o
        FROM turns
    `).get() as { i: number; o: number };

    return {
      totalInputTokens: tokens.i,
      totalOutputTokens: tokens.o,
      sessionCount: count('sessions'),
      turnCount: count('turns'),
      messageCount: count('messages'),
      taskCount: count('tasks'),
      agentRunCount: count('agent_runs'),
      toolExecutionCount: count('tool_executions'),
      backgroundProcessCount: count('background_processes'),
      attachmentCount: images.c + pasted.c,
      attachmentTotalBytes: images.b + pasted.b,
      visionDescriptionCount: vision.c,
      visionDescriptionBytes: vision.b,
      audioCount: speechOutputs.c,
      audioDurationMs: speechOutputs.d,
    };
  }
}

export interface SessionSummary {
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

/** 存储页 Session 手风琴的行投影:身份+最后活跃+消息数+Token 合计,一条 SQL 取全。 */
export interface SessionListSummary {
  id: string;
  title: string;
  lastActivityAt: number;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export class SessionStatsRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 存储页 Session 列表:按最后活跃倒序,一行带摘要。 */
  listSummaries(): SessionListSummary[] {
    const rows = this.db.prepare(`
      SELECT s.id, s.title, s.last_activity_at,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
             COALESCE((SELECT SUM(t.usage_input_tokens)  FROM turns t WHERE t.session_id = s.id), 0) AS input_tokens,
             COALESCE((SELECT SUM(t.usage_output_tokens) FROM turns t WHERE t.session_id = s.id), 0) AS output_tokens
        FROM sessions s
        ORDER BY s.last_activity_at DESC, s.id DESC
    `).all() as Array<{
      id: string; title: string; last_activity_at: number;
      message_count: number; input_tokens: number; output_tokens: number;
    }>;
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      lastActivityAt: row.last_activity_at,
      messageCount: row.message_count,
      totalInputTokens: row.input_tokens,
      totalOutputTokens: row.output_tokens,
    }));
  }

  /** 全部 Session 的消息数与 Token 合计:L2 折叠态行的数字源,一次 GROUP BY 取全。 */
  summariesBySession(): Map<string, SessionSummary> {
    const rows = this.db.prepare(`
      SELECT s.id AS session_id,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
             COALESCE((SELECT SUM(t.usage_input_tokens)  FROM turns t WHERE t.session_id = s.id), 0) AS input_tokens,
             COALESCE((SELECT SUM(t.usage_output_tokens) FROM turns t WHERE t.session_id = s.id), 0) AS output_tokens
        FROM sessions s
    `).all() as Array<{ session_id: string; message_count: number; input_tokens: number; output_tokens: number }>;
    return new Map(rows.map(row => [row.session_id, {
      messageCount: row.message_count,
      totalInputTokens: row.input_tokens,
      totalOutputTokens: row.output_tokens,
    }]));
  }

  getStats(sessionId: string): SessionStats {
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE session_id = ?`)
        .get(sessionId) as CountRow).c;
    const countBytes = (table: string): CountBytesRow =>
      this.db.prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(byte_size), 0) AS b
           FROM ${table} WHERE session_id = ?`,
      ).get(sessionId) as CountBytesRow;

    // turns 的六项指标一次索引扫描取全(旧版拆六个子查询, 同区间重复解码六轮)。
    const turns = this.db.prepare(`
      SELECT COUNT(*) AS turn_count,
             COALESCE(SUM(usage_input_tokens), 0)  AS total_input_tokens,
             COALESCE(SUM(usage_output_tokens), 0) AS total_output_tokens,
             COALESCE(SUM(execution_profile = 'chat'), 0) AS chat_turns,
             COALESCE(SUM(execution_profile = 'work'), 0) AS work_turns,
             COALESCE(SUM(narrative_policy = 'always'), 0) AS narrative_always_turns
        FROM turns WHERE session_id = ?
    `).get(sessionId) as {
      turn_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      chat_turns: number;
      work_turns: number;
      narrative_always_turns: number;
    };
    const speechOutputs = this.db.prepare(`
      SELECT COUNT(*) AS c,
             COALESCE(SUM(byte_size), 0) AS b,
             COALESCE(SUM(duration_ms), 0) AS d
        FROM speech_outputs WHERE session_id = ?
    `).get(sessionId) as { c: number; b: number; d: number };
    const images = countBytes('attachment_images');
    const pasted = countBytes('attachment_pasted_texts');

    return {
      turnCount: turns.turn_count,
      messageCount: count('messages'),
      taskCount: count('tasks'),
      agentRunCount: count('agent_runs'),
      toolExecutionCount: count('tool_executions'),
      backgroundProcessCount: count('background_processes'),
      totalInputTokens: turns.total_input_tokens,
      totalOutputTokens: turns.total_output_tokens,
      chatTurns: turns.chat_turns,
      workTurns: turns.work_turns,
      narrativeAlwaysTurns: turns.narrative_always_turns,
      audioTurnCount: speechOutputs.c,
      audioTotalBytes: speechOutputs.b,
      audioTotalDurationMs: speechOutputs.d,
      attachmentCount: images.c + pasted.c,
      attachmentTotalBytes: images.b + pasted.b,
    };
  }
}
