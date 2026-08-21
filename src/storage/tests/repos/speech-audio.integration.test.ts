// 测试逐句音频片段的登记、容量统计、最旧排序与 Session 级联删除。

import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { SpeechSegmentsRepo } from '../../repos/data/speechOutputs.js';

let database: Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe('SpeechSegmentsRepo', () => {
  it('按创建时间返回最旧片段并统计文件数与字节数', () => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    insertSessionAndTurn(database, 'session-1', 'turn-1');
    const repo = new SpeechSegmentsRepo(database.sqlite);

    repo.record(segment('segment-2', 1, 20, 200));
    repo.record(segment('segment-1', 0, 10, 100));

    expect(repo.usage()).toEqual({ fileCount: 2, totalBytes: 30 });
    expect(repo.listOldest(1).map(row => row.id)).toEqual(['segment-1']);
  });

  it('删除 Session 时由外键级联删除片段记录', () => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    insertSessionAndTurn(database, 'session-1', 'turn-1');
    const repo = new SpeechSegmentsRepo(database.sqlite);
    repo.record(segment('segment-1', 0, 10, 100));

    database.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run('session-1');

    expect(repo.usage()).toEqual({ fileCount: 0, totalBytes: 0 });
  });
});

function segment(id: string, sentenceIndex: number, byteSize: number, createdAt: number) {
  return {
    id,
    turnId: 'turn-1',
    sessionId: 'session-1',
    sentenceIndex,
    storagePath: `segments/${id}.mp3`,
    mimeType: 'audio/mpeg',
    byteSize,
    durationMs: null,
    text: `sentence ${sentenceIndex}`,
    createdAt,
  };
}

function insertSessionAndTurn(database: Database, sessionId: string, turnId: string): void {
  database.sqlite.prepare(`
    INSERT INTO sessions (
      id, title, last_activity_at, created_at, updated_at,
      execution_profile, narrative_policy
    ) VALUES (?, 'test', 1, 1, 1, 'chat', 'auto')
  `).run(sessionId);
  database.sqlite.prepare(`
    INSERT INTO turns (
      id, session_id, status, trigger_type, execution_profile,
      narrative_policy, iterations, usage_input_tokens,
      usage_output_tokens, created_at
    ) VALUES (?, ?, 'completed', 'userMessage', 'chat', 'auto', 0, 0, 0, 1)
  `).run(turnId, sessionId);
}
