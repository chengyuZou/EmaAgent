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
  /** attachment_images + attachment_pasted_texts 两本账合计。 */
  attachmentCount: number;
  attachmentTotalBytes: number;
  visionDescriptionCount: number;
  visionDescriptionBytes: number;
  audioCount: number;
  audioDurationMs: number;
  speechSegmentCount: number;
  speechSegmentBytes: number;
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
  speechSegmentCount: number;
  speechSegmentBytes: number;
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
    const speechSegments = countBytes('speech_segments');

    return {
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
      speechSegmentCount: speechSegments.c,
      speechSegmentBytes: speechSegments.b,
    };
  }
}

export class SessionStatsRepo {
  constructor(private readonly db: SqliteDb) {}

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
    const speechSegments = countBytes('speech_segments');
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
      speechSegmentCount: speechSegments.c,
      speechSegmentBytes: speechSegments.b,
      attachmentCount: images.c + pasted.c,
      attachmentTotalBytes: images.b + pasted.b,
    };
  }
}
