import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { SpeechOutputsRepo } from '../../repos/data/speechOutputs.js';

let database: Database;
let outputs: SpeechOutputsRepo;

beforeEach(() => {
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
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
  outputs.record({
    sessionId: 'session',
    turnId,
    storagePath: `D:/data/sessions/session/audio/${turnId}/${turnId}-${characterName}.wav`,
    mimeType: 'audio/wav',
    byteSize: 204,
    durationMs: 10,
    createdAt,
  });
}

describe('逐角色音频记录', () => {
  it('同一轮可保存多个角色, 同路径只替换自己的记录', () => {
    record('a', '艾玛', 4);
    record('a', '希罗-测试', 5);
    const other = outputs.listForTurn('a').find(row => row.storage_path.endsWith('-希罗-测试.wav'));
    record('a', '艾玛', 6);
    const records = outputs.listForTurn('a');
    expect(records).toHaveLength(2);
    expect(records.find(row => row.storage_path.endsWith('-艾玛.wav'))?.created_at).toBe(6);
    expect(records.find(row => row.storage_path.endsWith('-希罗-测试.wav'))).toEqual(other);
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
        { turnId: 'a', createdAt: 1, status: 'completed', audioCount: 2, totalByteSize: 408, totalDurationMs: 20 },
      ],
      nextCursor: null,
    });
  });

  it('删除轮次一并删除全部角色记录', () => {
    record('a', '艾玛', 4);
    record('a', '希罗-测试', 5);
    database.sqlite.prepare("DELETE FROM turns WHERE id = 'a'").run();
    expect(outputs.listForTurn('a')).toEqual([]);
    expect(outputs.listForSession('session')).toEqual([]);
  });
});
