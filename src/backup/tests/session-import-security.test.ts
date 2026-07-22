// 测试 Session 备份导入的路径、体积、格式和事务回滚边界。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionBackupFacade } from '../facade.js';
import {
  extractSessionArchive,
  SESSION_IMPORT_LIMITS,
  type SessionImportLimits,
} from '../import/archive.js';
import { SessionImportError } from '../import/errors.js';
import { SessionImportFileCommit } from '../import/file-commit.js';
import { assertPortableImportId, resolvePathInside } from '../import/path-policy.js';
import { exportSessionZipV1, SessionExportError } from '../export/zip-v1.js';
import type { SessionExportSnapshot } from '../types.js';

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-session-import-'));
  roots.push(root);
  return root;
}
function limits(overrides: Partial<SessionImportLimits> = {}): SessionImportLimits {
  return { ...SESSION_IMPORT_LIMITS, ...overrides };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Session ZIP 安全导入', () => {
  it('逐条落盘并读取受限 JSON', () => {
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ version: '1' })),
      'session.json': strToU8(JSON.stringify({ id: 'session-1' })),
      'audio/turn-1.mp3': new Uint8Array([1, 2, 3, 4]),
    });
    const extracted = extractSessionArchive(zip, tempRoot());
    const stagingDir = extracted.stagingDir;
    try {
      expect(extracted.readJson<{ version: string }>('manifest.json', true)).toEqual({ version: '1' });
      expect(fs.readFileSync(extracted.filePath('audio/turn-1.mp3')!)).toEqual(Buffer.from([1, 2, 3, 4]));
    } finally {
      extracted.dispose();
      expect(fs.existsSync(stagingDir)).toBe(false);
    }
  });

  it('拒绝 ZIP 条目路径穿越', () => {
    const zip = zipSync({ '../manifest.json': strToU8('{}') });
    expect(() => extractSessionArchive(zip, tempRoot())).toThrowError(
      expect.objectContaining<Partial<SessionImportError>>({ code: 'unsafe_archive_path' }),
    );
  });

  it('按照真实展开字节中止压缩炸弹', () => {
    const zip = zipSync({ 'messages.json': new Uint8Array(4096).fill(65) });
    expect(() => extractSessionArchive(zip, tempRoot(), limits({
      maxEntryBytes: 1024,
      maxExpandedBytes: 2048,
      maxCompressionRatio: 10_000,
    }))).toThrowError(
      expect.objectContaining<Partial<SessionImportError>>({ code: 'entry_too_large' }),
    );
  });

  it('拒绝大小写不同但跨平台会冲突的重复条目', () => {
    const zip = zipSync({ 'manifest.json': strToU8('{}'), 'MANIFEST.JSON': strToU8('{}') });
    expect(() => extractSessionArchive(zip, tempRoot())).toThrowError(
      expect.objectContaining<Partial<SessionImportError>>({ code: 'invalid_format' }),
    );
  });
});

describe('导入目标路径与失败回滚', () => {
  it('拒绝 JSON 元数据中的恶意 ID', () => {
    expect(() => assertPortableImportId('../../profile.db', 'Session id')).toThrowError(
      expect.objectContaining<Partial<SessionImportError>>({ code: 'invalid_format' }),
    );
    expect(() => resolvePathInside(tempRoot(), '..', 'profile.db')).toThrowError(
      expect.objectContaining<Partial<SessionImportError>>({ code: 'unsafe_archive_path' }),
    );
  });

  it('恢复失败时删除 Session 文件和共享附件', () => {
    const root = tempRoot();
    const source = path.join(root, 'source.bin');
    fs.writeFileSync(source, 'content');
    const commit = new SessionImportFileCommit(root, 'session-1');
    const audio = commit.copyToSession(source, 'audio', 'merged', 'turn-1.mp3');
    const attachment = commit.copyAttachment(source, 'attachment-1', 'a.txt');
    expect(fs.existsSync(audio)).toBe(true);
    expect(fs.existsSync(attachment)).toBe(true);
    commit.rollback();
    expect(fs.existsSync(commit.sessionRoot)).toBe(false);
    expect(fs.existsSync(attachment)).toBe(false);
  });
});

describe('SessionBackupFacade 演进契约', () => {
  it('通过分块来源导入，调用方不依赖 Web File 或 Uint8Array API', async () => {
    const root = tempRoot();
    const restoreRows = vi.fn();
    const facade = new SessionBackupFacade({
      activeDataDir: root,
      artifactsEnabled: false,
      sessionExists: () => false,
      restoreRows,
      collectExport: () => null,
    });
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ version: '1' })),
      'session.json': strToU8(JSON.stringify({
        id: 'session-1', title: 'Imported', workspaceRoot: null,
        createdAt: 1, updatedAt: 1, lastActivityAt: 1,
        archivedAt: null, pinned: false, pinnedAt: null,
        groupLabel: null, parentSessionId: null,
        executionProfile: 'chat', narrativePolicy: 'auto',
        preferredProviderConfigId: 'provider-config-1', preferredModelId: 'model-1',
        activeBranchId: null,
      })),
    });
    const split = Math.floor(zip.byteLength / 2);

    const result = await facade.importSession({
      source: {
        declaredSize: zip.byteLength,
        async *chunks() {
          yield zip.subarray(0, split);
          yield zip.subarray(split);
        },
      },
    });

    expect(result).toMatchObject({ sessionId: 'session-1', format: 'zip-v1' });
    expect(restoreRows).toHaveBeenCalledOnce();
    expect(restoreRows.mock.calls[0]?.[0].session).toMatchObject({
      preferredProviderConfigId: 'provider-config-1',
      preferredModelId: 'model-1',
    });
  });

  it('明确声明 ZIP v2 能力尚未启用', () => {
    const facade = new SessionBackupFacade({
      activeDataDir: tempRoot(),
      artifactsEnabled: false,
      sessionExists: () => false,
      restoreRows: vi.fn(),
      collectExport: () => null,
    });
    expect(facade.capabilities()).toEqual({
      importFormats: ['zip-v1'],
      exportFormats: ['zip-v1'],
      streamingArchiveInput: false,
      streamingArchiveOutput: false,
      streamingJsonRecords: false,
      multipartVolumes: false,
      integrityManifest: false,
    });
  });

  it('ZIP v1 导出也只经过 Facade，并明确保持同步内存边界', () => {
    const facade = new SessionBackupFacade({
      activeDataDir: tempRoot(),
      artifactsEnabled: false,
      sessionExists: () => false,
      restoreRows: vi.fn(),
      collectExport: () => ({
        session: {
          id: 'session-123456',
          title: '导出测试',
          preferredProviderConfigId: 'provider-config-1',
          preferredModelId: 'model-1',
        },
        turns: [{ id: 'turn-1' }], messages: [], artifacts: [], attachments: [],
        audio: [], notes: null, branches: [], agentTasks: [],
        agentTaskMessages: [], memoryState: null, kbActivations: [],
        usageRecords: [],
      }),
    });

    const result = facade.exportSession({ sessionId: 'session-123456' });
    expect(result?.filename).toBe('ema-导出测试-123456.zip');
    const entries = unzipSync(result!.bytes);
    expect(JSON.parse(strFromU8(entries['manifest.json']!))).toMatchObject({
      version: '1', sessionId: 'session-123456',
    });
    expect(JSON.parse(strFromU8(entries['turns.json']!))).toEqual([{ id: 'turn-1' }]);
    expect(JSON.parse(strFromU8(entries['session.json']!))).toMatchObject({
      preferredProviderConfigId: 'provider-config-1',
      preferredModelId: 'model-1',
    });
  });

  it('ZIP v1 在读取无界文件前执行导出预算', () => {
    const root = tempRoot();
    const largeFile = path.join(root, 'large.bin');
    fs.writeFileSync(largeFile, new Uint8Array(32));
    const snapshot: SessionExportSnapshot = {
      session: { id: 'session-1', title: 'Budget' },
      turns: [], messages: [], artifacts: [],
      attachments: [{
        id: 'attachment-1', name: 'large.bin', mime: 'application/octet-stream',
        size: 32, turnId: 'turn-1', mtime: 0, createdAt: 1, localPath: largeFile,
      }],
      audio: [], notes: null, branches: [], agentTasks: [], agentTaskMessages: [],
      memoryState: null, kbActivations: [], usageRecords: [],
    };

    expect(() => exportSessionZipV1(snapshot, false, {
      maxEntryBytes: 16,
      maxExpandedBytes: 1024,
      maxArchiveBytes: 1024,
    })).toThrowError(expect.objectContaining<Partial<SessionExportError>>({
      code: 'export_too_large',
      status: 413,
    }));
  });
});
