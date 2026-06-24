import type { SqliteDb } from '../database.js';

// ── Result types ──────────────────────────────────────────────────────────────

export interface SessionStats {
  turnCount:            number;
  messageCount:         number;
  totalInputTokens:     number;
  totalOutputTokens:    number;
  chatTurns:            number;
  narrativeTurns:       number;
  agentTurns:           number;
  branchCount:          number;
  artifactCount:        number;
  artifactInlineBytes:  number;
  audioTurnCount:       number;
  audioTotalBytes:      number;
  audioTotalDurationMs: number;
  attachmentCount:      number;
  attachmentTotalBytes: number;
}

export interface AudioEntryRow {
  turn_id:       string;
  mime_type:     string;
  byte_size:     number;
  duration_ms:   number | null;
  segment_count: number;
  created_at:    number;
  storage_path:  string;
}

export interface ArtifactSummaryRow {
  id:               string;
  type:             string;
  title:            string;
  content_location: string;
  byte_size:        number;
  created_at:       number;
  applied_at:       number | null;
  rejected_at:      number | null;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

export class SessionStatsRepo {
  constructor(private readonly db: SqliteDb) {}

  getStats(sessionId: string): SessionStats {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM turns       WHERE session_id = ?) AS turn_count,
        (SELECT COUNT(*) FROM messages    WHERE session_id = ?) AS message_count,
        (SELECT COALESCE(SUM(usage_input_tokens),  0) FROM turns WHERE session_id = ?) AS total_input_tokens,
        (SELECT COALESCE(SUM(usage_output_tokens), 0) FROM turns WHERE session_id = ?) AS total_output_tokens,
        (SELECT COUNT(*) FROM turns WHERE session_id = ? AND mode = 'chat')      AS chat_turns,
        (SELECT COUNT(*) FROM turns WHERE session_id = ? AND mode = 'narrative') AS narrative_turns,
        (SELECT COUNT(*) FROM turns WHERE session_id = ? AND mode = 'agent')     AS agent_turns,
        -- +1 for the implicit main line: forked branch rows carry a branch_id,
        -- main-line turns have NULL (which COUNT DISTINCT ignores).
        ((SELECT COUNT(DISTINCT branch_id) FROM turns WHERE session_id = ? AND branch_id IS NOT NULL) + 1) AS branch_count,
        (SELECT COUNT(*) FROM artifacts WHERE session_id = ?) AS artifact_count,
        (SELECT COALESCE(SUM(LENGTH(COALESCE(content,''))), 0)
           FROM artifacts WHERE session_id = ? AND content_location = 'inline')  AS artifact_inline_bytes,
        (SELECT COUNT(*) FROM turn_audio_merged WHERE session_id = ?) AS audio_turn_count,
        (SELECT COALESCE(SUM(byte_size),    0) FROM turn_audio_merged WHERE session_id = ?) AS audio_total_bytes,
        (SELECT COALESCE(SUM(duration_ms),  0) FROM turn_audio_merged WHERE session_id = ?) AS audio_total_duration_ms,
        (SELECT COUNT(*) FROM turn_attachments WHERE session_id = ?) AS attachment_count,
        (SELECT COALESCE(SUM(size), 0) FROM turn_attachments WHERE session_id = ?) AS attachment_total_bytes
    `).get(
      sessionId, sessionId, sessionId, sessionId,
      sessionId, sessionId, sessionId, sessionId,
      sessionId, sessionId,
      sessionId, sessionId, sessionId,
      sessionId, sessionId,
    ) as {
      turn_count:            number; message_count:        number;
      total_input_tokens:    number; total_output_tokens:  number;
      chat_turns:            number; narrative_turns:      number; agent_turns: number;
      branch_count:          number;
      artifact_count:        number; artifact_inline_bytes: number;
      audio_turn_count:      number; audio_total_bytes:    number; audio_total_duration_ms: number;
      attachment_count:      number; attachment_total_bytes: number;
    };

    return {
      turnCount:            row.turn_count,
      messageCount:         row.message_count,
      totalInputTokens:     row.total_input_tokens,
      totalOutputTokens:    row.total_output_tokens,
      chatTurns:            row.chat_turns,
      narrativeTurns:       row.narrative_turns,
      agentTurns:           row.agent_turns,
      branchCount:          row.branch_count,
      artifactCount:        row.artifact_count,
      artifactInlineBytes:  row.artifact_inline_bytes,
      audioTurnCount:       row.audio_turn_count,
      audioTotalBytes:      row.audio_total_bytes,
      audioTotalDurationMs: row.audio_total_duration_ms,
      attachmentCount:      row.attachment_count,
      attachmentTotalBytes: row.attachment_total_bytes,
    };
  }

  listAudioEntries(sessionId: string): AudioEntryRow[] {
    return this.db.prepare(`
      SELECT turn_id, mime_type, byte_size, duration_ms, segment_count, created_at, storage_path
      FROM turn_audio_merged
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as AudioEntryRow[];
  }

  listArtifactSummaries(sessionId: string): ArtifactSummaryRow[] {
    return this.db.prepare(`
      SELECT id, type, title, content_location,
             CASE WHEN content_location = 'inline'
                  THEN LENGTH(COALESCE(content, ''))
                  ELSE 0
             END AS byte_size,
             created_at, applied_at, rejected_at
      FROM artifacts
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as ArtifactSummaryRow[];
  }

  /** Used during import to insert a merged-audio row. */
  insertAudio(row: {
    turnId: string; sessionId: string; storagePath: string;
    mimeType: string; byteSize: number; durationMs: number | null;
    segmentCount: number; createdAt: number;
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO turn_audio_merged
        (turn_id, session_id, storage_path, mime_type, byte_size, duration_ms, segment_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.turnId, row.sessionId, row.storagePath,
      row.mimeType, row.byteSize, row.durationMs,
      row.segmentCount, row.createdAt,
    );
  }
}
