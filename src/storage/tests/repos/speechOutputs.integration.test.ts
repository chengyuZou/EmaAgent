import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '../../database/database.js';
import { SpeechOutputsRepo } from '../../repos/data/speechOutputs.js';
import { SpeechSegmentsRepo } from '../../repos/data/speechSegments.js';

let database: Database;
let outputs: SpeechOutputsRepo;

beforeEach(async () => {
  database = new Database({ memory: true, kind: 'data' });
  await database.migrate();
  outputs = new SpeechOutputsRepo(database.sqlite);
  database.sqlite.prepare(`
    INSERT INTO sessions (id, title, cwd, last_activity_at, created_at, updated_at)
    VALUES ('session', '语音记录', 'D:/work', 1, 1, 1), ('other', '其他会话', 'D:/work', 1, 1, 1)
  `).run();
  database.sqlite.prepare(`
    INSERT INTO turns (id, session_id, status, created_at)
    VALUES ('a', 'session', 'completed', 1), ('b', 'session', 'completed', 2),
      ('c', 'session', 'running', 2), ('other-turn', 'other', 'completed', 3)
  `).run();
});

afterEach(() => database.close());

function record(turnId: string, characterName: string, createdAt: number): void {
  const audioId = randomUUID();
  outputs.insertAudio({
    audioId,
    characterName,
    sessionId: 'session',
    turnId,
    storagePath: `D:/data/audio/session/${turnId}/${turnId}-${characterName}-${audioId}.wav`,
    mimeType: 'audio/wav',
    audioStatus: 'ready',
    failureMessage: null,
    byteSize: 204,
    durationMs: 10,
    createdAt,
  });
}

describe('逐角色音频记录', () => {
  it('未完成的记录使用 null, ready 必须已经有确定大小和时长', () => {
    outputs.insertAudio({
      audioId: 'generating', characterName: '艾玛', sessionId: 'session', turnId: 'a',
      storagePath: 'D:/audio/艾玛-generating.wav', mimeType: 'audio/wav',
      audioStatus: 'generating', failureMessage: null, byteSize: null, durationMs: null, createdAt: 1,
    });
    expect(outputs.findByAudioId('generating')).toMatchObject({ byte_size: null, duration_ms: null });
    expect(() => database.sqlite.prepare("UPDATE speech_outputs SET audio_status = 'ready' WHERE audio_id = 'generating'").run())
      .toThrow(/CHECK constraint failed/);
    outputs.completeAudio('generating', 204, 10);
    expect(outputs.findByAudioId('generating')).toMatchObject({ audio_status: 'ready', byte_size: 204, duration_ms: 10 });
  });
  it('同一轮同一角色的多次生成保留独立记录, 默认选择最新 ready', () => {
    record('a', '艾玛', 4);
    record('a', '希罗-测试', 5);
    const original = outputs.findLatestReadyForCharacter('a', '艾玛')!;
    const other = outputs.findLatestReadyForCharacter('a', '希罗-测试');
    record('a', '艾玛', 6);
    const records = outputs.listAudioSummaries('a');
    expect(records).toHaveLength(3);
    const replacement = outputs.findLatestReadyForCharacter('a', '艾玛')!;
    expect(replacement.created_at).toBe(6);
    expect(replacement.audio_id).not.toBe(original.audio_id);
    expect(replacement.storage_path).not.toBe(original.storage_path);
    expect(outputs.findByAudioId(original.audio_id)).toEqual(original);
    expect(outputs.findLatestReadyForCharacter('a', '希罗-测试')).toEqual(other);
  });

  it('目录按轮次分页, 无音频轮次也有摘要, 重新生成不改变顺序', () => {
    record('a', '艾玛', 4);
    record('a', '希罗-测试', 5);
    const first = outputs.listPage('session', undefined, 2);
    expect(first.items).toEqual([
      { turnId: 'c', createdAt: 2, status: 'running', audioCount: 0, totalByteSize: 0, totalDurationMs: 0 },
      { turnId: 'b', createdAt: 2, status: 'completed', audioCount: 0, totalByteSize: 0, totalDurationMs: 0 },
    ]);
    expect(first.nextCursor).toEqual({ createdAt: 2, id: 'b' });
    record('a', '艾玛', 100);
    expect(outputs.listPage('session', undefined, 2)).toEqual(first);
    expect(outputs.listPage('session', first.nextCursor!, 2)).toEqual({
      items: [
        { turnId: 'a', createdAt: 1, status: 'completed', audioCount: 3, totalByteSize: 612, totalDurationMs: 30 },
      ],
      nextCursor: null,
    });
  });

  it('删除轮次一并删除全部角色记录', () => {
    record('a', '艾玛', 4);
    record('a', '希罗-测试', 5);
    database.sqlite.prepare("DELETE FROM turns WHERE id = 'a'").run();
    expect(outputs.listAudioSummaries('a')).toEqual([]);
    expect(outputs.listForSession('session')).toEqual([]);
  });

  it('stores ordered segments independently and deletes them with their audio owner', () => {
    const output = {
      sessionId: 'session', turnId: 'a', characterName: 'Ema',
      storagePath: 'D:/audio/a-Ema.wav', mimeType: 'audio/wav' as const,
      byteSize: 204, durationMs: 10, createdAt: 1,
    };
    const segments = new SpeechSegmentsRepo(database.sqlite);
    outputs.insertAudio({ ...output, audioId: 'first', audioStatus: 'ready', failureMessage: null });
    segments.insertForAudio('first', [
      { segmentIndex: 0, textForTTS: 'First.', startMs: 0, endMs: 10 },
    ]);
    expect(outputs.findByAudioId('first')?.audio_id).toBe('first');
    expect(segments.listForAudio('first')[0]?.text_for_tts).toBe('First.');
    database.sqlite.prepare("DELETE FROM turns WHERE id = 'a'").run();
    expect(segments.listForAudio('first')).toEqual([]);
  });
});
