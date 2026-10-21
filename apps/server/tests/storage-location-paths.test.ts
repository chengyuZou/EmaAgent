import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_RESOURCE_KINDS, sessionResourceDir, turnResourceDir } from '@ema-agent/storage/dataPaths';
import {
  sqliteFileSet,
  sweepOrphanSessionDirectories,
  removeOrphanSessionDirectories,
  removeSessionFiles,
  removeTurnFiles,
  sweepOrphanTurnFiles,
  backgroundProcessOutputDirFor,
} from '../src/platform/paths.js';

function withDirectory(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'ema-resource-paths-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('data resource paths', () => {
  it('keeps SQLite companions beside their database', () => {
    expect(sqliteFileSet('D:/Ema Data/profile.db')).toEqual([
      'D:/Ema Data/profile.db',
      'D:/Ema Data/profile.db-wal',
      'D:/Ema Data/profile.db-shm',
    ]);
  });

  it('removes all orphan resource directories and preserves live Sessions and backup staging', () => {
    withDirectory(root => {
      for (const kind of SESSION_RESOURCE_KINDS) {
        for (const id of ['live', 'orphan']) {
          const directory = sessionResourceDir(root, kind, id);
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, 'resource'), id);
        }
      }
      const staging = join(root, '.backup-temp', 'imports', 'pending');
      mkdirSync(staging, { recursive: true });
      const result = sweepOrphanSessionDirectories(root, id => id === 'live');
      expect(result).toEqual({ removed: SESSION_RESOURCE_KINDS.length, failed: 0 });
      for (const kind of SESSION_RESOURCE_KINDS) {
        expect(existsSync(sessionResourceDir(root, kind, 'live'))).toBe(true);
        expect(existsSync(sessionResourceDir(root, kind, 'orphan'))).toBe(false);
      }
      expect(existsSync(staging)).toBe(true);
    });
  });

  it('removes partially published imports before requests are accepted', () => {
    withDirectory(root => {
      for (const kind of ['attachments', 'web-fetch'] as const) {
        mkdirSync(sessionResourceDir(root, kind, 'interrupted'), { recursive: true });
      }
      expect(removeOrphanSessionDirectories(root, () => false)).toBe(2);
      expect(removeOrphanSessionDirectories(root, () => false)).toBe(0);
    });
  });

  it('Session deletion removes only its own resources across all resource types', () => {
    withDirectory(root => {
      for (const kind of SESSION_RESOURCE_KINDS) {
        for (const id of ['remove', 'keep']) {
          mkdirSync(sessionResourceDir(root, kind, id), { recursive: true });
        }
      }
      removeSessionFiles(root, 'remove');
      for (const kind of SESSION_RESOURCE_KINDS) {
        expect(existsSync(sessionResourceDir(root, kind, 'remove'))).toBe(false);
        expect(existsSync(sessionResourceDir(root, kind, 'keep'))).toBe(true);
      }
    });
  });

  it('Turn deletion and orphan cleanup preserve other Turns and Session-level files', () => {
    withDirectory(root => {
      for (const kind of ['audio', 'scratchpad'] as const) {
        for (const id of ['remove', 'orphan', 'keep']) {
          mkdirSync(turnResourceDir(root, kind, 'session', id), { recursive: true });
        }
      }
      const download = sessionResourceDir(root, 'web-fetch', 'session');
      mkdirSync(download, { recursive: true });
      removeTurnFiles(root, 'session', 'remove');
      expect(sweepOrphanTurnFiles(root, () => new Set(['keep']))).toEqual({ removed: 2 });
      for (const kind of ['audio', 'scratchpad'] as const) {
        expect(existsSync(turnResourceDir(root, kind, 'session', 'remove'))).toBe(false);
        expect(existsSync(turnResourceDir(root, kind, 'session', 'keep'))).toBe(true);
      }
      expect(existsSync(download)).toBe(true);
    });
  });

  it('background outputs use a relative path under the resource-first layout', () => {
    withDirectory(root => {
      expect(backgroundProcessOutputDirFor(root, 'session', 'process')).toEqual({
        absoluteDirectory: join(root, 'background-processes', 'session', 'process'),
        relativeDirectory: join('background-processes', 'session', 'process'),
      });
    });
  });
});
