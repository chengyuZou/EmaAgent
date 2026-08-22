// 测试 RuntimePaths 的数据库文件集合、启动清理和资源路径边界。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sqliteFileSet,
  sweepOrphanSessionDirectories,
  sweepOrphanTurnFiles,
  removeLegacyArtifactDirectories,
} from '../src/platform/paths.js';

describe('sqliteFileSet', () => {
  it('返回同一个数据库对应的三个文件', () => {
    expect(sqliteFileSet('D:\\Ema Data\\profile.db')).toEqual([
      'D:\\Ema Data\\profile.db',
      'D:\\Ema Data\\profile.db-wal',
      'D:\\Ema Data\\profile.db-shm',
    ]);
  });
});

describe('sweepOrphanSessionDirectories', () => {
  it('删除数据库已不存在的整棵目录并保留存活 Session', () => {
    const root = mkdtempSync(join(tmpdir(), 'ema-session-sweep-'));
    try {
      const liveDir = join(root, 'sessions', 'session-live');
      const orphanDir = join(root, 'sessions', 'session-orphan');
      mkdirSync(join(liveDir, 'audio'), { recursive: true });
      mkdirSync(join(orphanDir, 'background-processes', 'process-1'), {
        recursive: true,
      });
      writeFileSync(
        join(orphanDir, 'background-processes', 'process-1', 'stdout.log'),
        'orphan',
      );

      const result = sweepOrphanSessionDirectories(
        root,
        sessionId => sessionId === 'session-live',
      );

      expect(result).toEqual({ removed: 1, failed: 0 });
      expect(existsSync(liveDir)).toBe(true);
      expect(existsSync(orphanDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('removeLegacyArtifactDirectories', () => {
  it('只删除旧 Artifact 子目录并保留其他 Session 文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'ema-artifact-cleanup-'));
    try {
      const firstArtifactDir = join(root, 'sessions', 'session-1', 'artifacts');
      const secondArtifactDir = join(root, 'sessions', 'session-2', 'artifacts');
      const audioFile = join(root, 'sessions', 'session-1', 'audio', 'merged', 'turn-1.mp3');
      mkdirSync(firstArtifactDir, { recursive: true });
      mkdirSync(secondArtifactDir, { recursive: true });
      mkdirSync(join(root, 'sessions', 'not-a-session.txt'), { recursive: true });
      mkdirSync(join(root, 'sessions', 'session-1', 'audio', 'merged'), { recursive: true });
      writeFileSync(join(firstArtifactDir, 'legacy.txt'), 'legacy');
      writeFileSync(audioFile, 'audio');

      expect(removeLegacyArtifactDirectories(root)).toBe(2);
      expect(existsSync(firstArtifactDir)).toBe(false);
      expect(existsSync(secondArtifactDir)).toBe(false);
      expect(existsSync(audioFile)).toBe(true);
      expect(removeLegacyArtifactDirectories(root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
