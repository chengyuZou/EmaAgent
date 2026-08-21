// 测试逐句音频片段库超过文件数或字节上限时删除最旧文件与记录。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database, SpeechSegmentsRepo } from '@ema-agent/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { FsAudioArchive } from '../audioArchive.js';
import { SpeechSegmentLibrary } from '../segmentLibrary.js';

let database: Database | undefined;
const roots: string[] = [];

afterEach(() => {
  database?.close();
  database = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('SpeechSegmentLibrary', () => {
  it('同时满足文件数与总字节上限才停止淘汰', () => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    insertSessionAndTurn(database);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-speech-library-'));
    roots.push(root);
    const archive = new FsAudioArchive(root);
    const repo = new SpeechSegmentsRepo(database.sqlite);
    const library = new SpeechSegmentLibrary(repo, archive);

    recordSegment(library, archive, 0, [1, 2], 100);
    recordSegment(library, archive, 1, [3, 4], 200);
    recordSegment(library, archive, 2, [5, 6], 300);
    library.enforceLimits({ maxFiles: 2, maxBytes: 4 });

    expect(repo.usage()).toEqual({ fileCount: 2, totalBytes: 4 });
    expect(fs.existsSync(path.join(root, 'session-1', 'audio', 'segments', 'turn-1', '0.pcm')))
      .toBe(false);
    expect(repo.listOldest(10).map(row => row.sentence_index)).toEqual([1, 2]);
  });
});

function recordSegment(
  library: SpeechSegmentLibrary,
  archive: FsAudioArchive,
  sentenceIndex: number,
  bytes: number[],
  createdAt: number,
): void {
  const writer = archive.openSegment('session-1', 'turn-1', sentenceIndex, 'pcm');
  writer.write(new Uint8Array(bytes));
  const completed = writer.close();
  library.record({
    id: `turn-1-${sentenceIndex}`,
    sessionId: 'session-1',
    turnId: 'turn-1',
    sentenceIndex,
    storagePath: completed.path,
    mimeType: completed.mime,
    byteSize: completed.byteSize,
    durationMs: null,
    text: `sentence ${sentenceIndex}`,
    createdAt,
  });
}

function insertSessionAndTurn(database: Database): void {
  database.sqlite.prepare(`
    INSERT INTO sessions (
      id, title, last_activity_at, created_at, updated_at,
      execution_profile, narrative_policy
    ) VALUES ('session-1', 'test', 1, 1, 1, 'chat', 'auto')
  `).run();
  database.sqlite.prepare(`
    INSERT INTO turns (
      id, session_id, status, trigger_type, execution_profile,
      narrative_policy, iterations, usage_input_tokens,
      usage_output_tokens, created_at
    ) VALUES ('turn-1', 'session-1', 'completed', 'userMessage', 'chat', 'auto', 0, 0, 0, 1)
  `).run();
}
