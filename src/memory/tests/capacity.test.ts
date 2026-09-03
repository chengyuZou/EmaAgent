// 验证 Memory 字节统计,存储边界和单次操作预算.

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupMemoryStorage } from '../capacity/automaticCleanup.js';
import { measureMemoryStorageBytes } from '../capacity/measureStorageBytes.js';
import {
  DEFAULT_MEMORY_STORAGE_LIMIT,
  evaluateMemoryStorage,
} from '../capacity/storageLimit.js';
import {
  MEMORY_CONSOLIDATION_INPUT_BYTES,
  MEMORY_TURN_EVIDENCE_FILE_BYTES,
} from '../capacity/limits.js';
import {
  listExpiredRelationshipHistoryFiles,
} from '../relationship/lifecycle.js';
import { listExpiredWorkHistoryFiles } from '../work/retention.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    await fs.rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

async function createMemoryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-memory-capacity-'));
  temporaryRoots.push(root);
  return root;
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('Memory capacity', () => {
  it('counts nested files and Git data but not directory entries', async () => {
    const root = await createMemoryRoot();
    await fs.mkdir(path.join(root, 'work', '.git', 'objects'), { recursive: true });
    await fs.writeFile(path.join(root, 'work', 'MEMORY.md'), 'abc', 'utf8');
    await fs.writeFile(path.join(root, 'work', '.git', 'objects', 'one'), '12345', 'utf8');

    await expect(measureMemoryStorageBytes(root)).resolves.toBe(8);
    await expect(measureMemoryStorageBytes(path.join(root, 'missing'))).resolves.toBe(0);
  });

  it('reports normal, warning and hard limit states', () => {
    const limit = { maxBytes: 100, warningAtBytes: 80 };

    expect(evaluateMemoryStorage(79, limit)).toMatchObject({
      level: 'normal',
      remainingBytes: 21,
    });
    expect(evaluateMemoryStorage(80, limit)).toMatchObject({
      level: 'warning',
      remainingBytes: 20,
    });
    expect(evaluateMemoryStorage(100, limit)).toMatchObject({
      level: 'limitExceeded',
      remainingBytes: 0,
    });
  });

  it('derives the fixed warning line and keeps evidence inside consolidation input', () => {
    expect(DEFAULT_MEMORY_STORAGE_LIMIT.warningAtBytes).toBe(
      Math.floor(DEFAULT_MEMORY_STORAGE_LIMIT.maxBytes * 0.8),
    );
    expect(MEMORY_TURN_EVIDENCE_FILE_BYTES).toBeLessThanOrEqual(
      MEMORY_CONSOLIDATION_INPUT_BYTES,
    );
  });

  it('expires only Work history whose last user edit is beyond the retention window', async () => {
    const root = await createMemoryRoot();
    const history = path.join(root, 'work', 'history');
    await fs.mkdir(history, { recursive: true });
    const oldFile = path.join(history, '2025-01-01.md');
    const recentFile = path.join(history, '2026-01-01.md');
    await fs.writeFile(oldFile, 'old', 'utf8');
    await fs.writeFile(recentFile, 'recent', 'utf8');
    const now = Date.UTC(2026, 0, 10);
    await fs.utimes(oldFile, new Date(now - 40 * 86_400_000), new Date(now - 40 * 86_400_000));
    await fs.utimes(recentFile, new Date(now - 2 * 86_400_000), new Date(now - 2 * 86_400_000));

    await expect(listExpiredWorkHistoryFiles(root, 30, now)).resolves.toEqual([
      'work/history/2025-01-01.md',
    ]);
  });

  it('keeps the newest active dates independently for every character', async () => {
    const root = await createMemoryRoot();
    for (const [character, dates] of [
      ['ema', ['2026-01-01', '2026-01-04', '2026-02-10']],
      ['margo', ['2025-12-01', '2026-03-01']],
    ] as const) {
      const history = path.join(root, 'relationship', 'characters', character, 'history');
      await fs.mkdir(history, { recursive: true });
      for (const date of dates) await fs.writeFile(path.join(history, `${date}.md`), date, 'utf8');
      await fs.writeFile(path.join(history, 'user-note.md'), 'protected', 'utf8');
    }

    await expect(listExpiredRelationshipHistoryFiles(root, 2)).resolves.toEqual([
      'relationship/characters/ema/history/2026-01-01.md',
    ]);
  });

  describe.skipIf(!gitAvailable())('automatic cleanup', () => {
    it('deletes derived evidence before history and never deletes core memory or notes', async () => {
      const root = await createMemoryRoot();
      const work = path.join(root, 'work');
      const evidence = path.join(work, 'turn_evidence', 'turn.md');
      const history = path.join(work, 'history', 'old.md');
      const memory = path.join(work, 'MEMORY.md');
      const note = path.join(work, 'extensions', 'notes', 'keep.md');
      await fs.mkdir(path.dirname(evidence), { recursive: true });
      await fs.mkdir(path.dirname(history), { recursive: true });
      await fs.mkdir(path.dirname(note), { recursive: true });
      await fs.writeFile(evidence, Buffer.alloc(2 * 1024 * 1024, 1));
      await fs.writeFile(history, Buffer.alloc(128 * 1024, 2));
      await fs.writeFile(memory, 'core', 'utf8');
      await fs.writeFile(note, 'unintegrated', 'utf8');

      await cleanupMemoryStorage(
        root,
        { maxBytes: 1024 * 1024, warningAtBytes: 512 * 1024 },
        { workHistoryRetentionDays: 90, relationshipHistoryActiveDays: 180 },
        new AbortController().signal,
        async () => {},
      );

      await expect(fs.stat(evidence)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(history)).resolves.toHaveLength(128 * 1024);
      await expect(fs.readFile(memory, 'utf8')).resolves.toBe('core');
      await expect(fs.readFile(note, 'utf8')).resolves.toBe('unintegrated');
    });
  });
});
