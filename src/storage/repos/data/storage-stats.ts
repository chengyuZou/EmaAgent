// 汇总 data.db 与单个 Session 的可展示统计，不承担备份、恢复或业务写入。
import type { SqliteDb } from '../../database/database.js';

export interface DataDirStats {
  sessionCount: number;
  turnCount: number;
  messageCount: number;
  taskCount: number;
  agentRunCount: number;
  toolExecutionCount: number;
  backgroundProcessCount: number;
  attachmentCount: number;
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

export class DataDirStatsRepo {
  constructor(private readonly db: SqliteDb) {}

  getStats(): DataDirStats {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions) AS session_count,
        (SELECT COUNT(*) FROM turns) AS turn_count,
        (SELECT COUNT(*) FROM messages) AS message_count,
        (SELECT COUNT(*) FROM tasks) AS task_count,
        (SELECT COUNT(*) FROM agent_runs) AS agent_run_count,
        (SELECT COUNT(*) FROM tool_executions) AS tool_execution_count,
        (SELECT COUNT(*) FROM background_processes) AS background_process_count,
        (SELECT COUNT(*) FROM attachments) AS attachment_count,
        (SELECT COUNT(*) FROM speech_outputs) AS audio_count,
        (SELECT COALESCE(SUM(duration_ms), 0) FROM speech_outputs) AS audio_duration_ms
    `).get() as {
      session_count: number;
      turn_count: number;
      message_count: number;
      task_count: number;
      agent_run_count: number;
      tool_execution_count: number;
      background_process_count: number;
      attachment_count: number;
      audio_count: number;
      audio_duration_ms: number;
    };

    return {
      sessionCount: row.session_count,
      turnCount: row.turn_count,
      messageCount: row.message_count,
      taskCount: row.task_count,
      agentRunCount: row.agent_run_count,
      toolExecutionCount: row.tool_execution_count,
      backgroundProcessCount: row.background_process_count,
      attachmentCount: row.attachment_count,
      audioCount: row.audio_count,
      audioDurationMs: row.audio_duration_ms,
    };
  }
}

export class SessionStatsRepo {
  constructor(private readonly db: SqliteDb) {}

  getStats(sessionId: string): SessionStats {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM turns WHERE session_id = ?) AS turn_count,
        (SELECT COUNT(*) FROM messages WHERE session_id = ?) AS message_count,
        (SELECT COUNT(*) FROM tasks WHERE session_id = ?) AS task_count,
        (SELECT COUNT(*) FROM agent_runs WHERE session_id = ?) AS agent_run_count,
        (SELECT COUNT(*) FROM tool_executions WHERE session_id = ?) AS tool_execution_count,
        (SELECT COUNT(*) FROM background_processes WHERE session_id = ?) AS background_process_count,
        (SELECT COALESCE(SUM(usage_input_tokens), 0) FROM turns WHERE session_id = ?) AS total_input_tokens,
        (SELECT COALESCE(SUM(usage_output_tokens), 0) FROM turns WHERE session_id = ?) AS total_output_tokens,
        (SELECT COUNT(*) FROM turns WHERE session_id = ? AND execution_profile = 'chat') AS chat_turns,
        (SELECT COUNT(*) FROM turns WHERE session_id = ? AND execution_profile = 'work') AS work_turns,
        (SELECT COUNT(*) FROM turns WHERE session_id = ? AND narrative_policy = 'always') AS narrative_always_turns,
        (SELECT COUNT(*) FROM speech_outputs WHERE session_id = ?) AS audio_turn_count,
        (SELECT COALESCE(SUM(byte_size), 0) FROM speech_outputs WHERE session_id = ?) AS audio_total_bytes,
        (SELECT COALESCE(SUM(duration_ms), 0) FROM speech_outputs WHERE session_id = ?) AS audio_total_duration_ms,
        (SELECT COUNT(*) FROM attachments WHERE session_id = ?) AS attachment_count,
        (SELECT COALESCE(SUM(byte_size), 0) FROM attachments WHERE session_id = ?) AS attachment_total_bytes
    `).get(
      sessionId, sessionId, sessionId, sessionId,
      sessionId, sessionId, sessionId, sessionId,
      sessionId, sessionId, sessionId, sessionId,
      sessionId, sessionId, sessionId, sessionId,
    ) as {
      turn_count: number;
      message_count: number;
      task_count: number;
      agent_run_count: number;
      tool_execution_count: number;
      background_process_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      chat_turns: number;
      work_turns: number;
      narrative_always_turns: number;
      audio_turn_count: number;
      audio_total_bytes: number;
      audio_total_duration_ms: number;
      attachment_count: number;
      attachment_total_bytes: number;
    };

    return {
      turnCount: row.turn_count,
      messageCount: row.message_count,
      taskCount: row.task_count,
      agentRunCount: row.agent_run_count,
      toolExecutionCount: row.tool_execution_count,
      backgroundProcessCount: row.background_process_count,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      chatTurns: row.chat_turns,
      workTurns: row.work_turns,
      narrativeAlwaysTurns: row.narrative_always_turns,
      audioTurnCount: row.audio_turn_count,
      audioTotalBytes: row.audio_total_bytes,
      audioTotalDurationMs: row.audio_total_duration_ms,
      attachmentCount: row.attachment_count,
      attachmentTotalBytes: row.attachment_total_bytes,
    };
  }
}
