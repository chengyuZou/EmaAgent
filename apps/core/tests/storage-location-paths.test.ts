// 这里测试 RuntimePaths 能否完整返回 SQLite 主文件及其 WAL/SHM 文件。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteFileSet, sweepOrphanTurnFiles, resolveCardVoiceRefPath } from '../src/storage-locations/paths.js';

describe('sqliteFileSet', () => {
  it('返回同一个数据库对应的三个文件', () => {
    expect(sqliteFileSet('D:\\Ema Data\\profile.db')).toEqual([
      'D:\\Ema Data\\profile.db',
      'D:\\Ema Data\\profile.db-wal',
      'D:\\Ema Data\\profile.db-shm',
    ]);
  });
});

describe('sweepOrphanTurnFiles(启动自检孤儿 turn 文件)', () => {
  it('清理 DB 已删 turn 的音频分段/合并文件/scratchpad, 保留 live turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'ema-sweep-'));
    try {
      const sid = 'sess-1';
      const segLive = join(root, 'sessions', sid, 'audio', 'segments', 'turn-live');
      const segDead = join(root, 'sessions', sid, 'audio', 'segments', 'turn-dead');
      const mergedDir = join(root, 'sessions', sid, 'audio', 'merged');
      const scratchDead = join(root, 'sessions', sid, 'scratchpad', 'turn-dead');
      mkdirSync(segLive, { recursive: true });
      mkdirSync(segDead, { recursive: true });
      mkdirSync(mergedDir, { recursive: true });
      mkdirSync(scratchDead, { recursive: true });
      writeFileSync(join(mergedDir, 'turn-live.mp3'), 'a');
      writeFileSync(join(mergedDir, 'turn-dead.mp3'), 'b');
      writeFileSync(join(scratchDead, 'note.md'), 'x');

      const result = sweepOrphanTurnFiles(root, () => new Set(['turn-live']));

      expect(result.removed).toBe(3);
      expect(existsSync(segLive)).toBe(true);
      expect(existsSync(segDead)).toBe(false);
      expect(existsSync(join(mergedDir, 'turn-live.mp3'))).toBe(true);
      expect(existsSync(join(mergedDir, 'turn-dead.mp3'))).toBe(false);
      expect(existsSync(scratchDead)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveCardVoiceRefPath(B-055 路径安全)', () => {
  it('放行 voiceRefs/ 单层文件名', () => {
    expect(() => resolveCardVoiceRefPath('card-a', false, 'voiceRefs/ra_ema001.mp3')).not.toThrow();
  });

  it.each([
    'voiceRefs/../../etc/passwd',
    'voiceRefs/../secret.wav',
    'voiceRefs/sub/dir/a.mp3',
    'voiceRefs/..',
    'voiceRefs/',
    'voiceRefs\\..\\..\\secret.wav',
    'voiceRefs\\valid-name.mp3',
    'C:\\Windows\\system.ini',
    '/etc/passwd',
    '../outside.mp3',
  ])('拒绝越界路径: %s', (relPath) => {
    expect(() => resolveCardVoiceRefPath('card-a', false, relPath)).toThrow(/invalid_voice_ref_path/);
  });
});
