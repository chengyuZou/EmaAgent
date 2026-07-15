import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SessionBackupFacade,
  SessionExportError,
  type SessionExportSnapshot,
} from '@ema-agent/backup';
import { SessionRestoreValidationError, type SessionRestorePayload } from '@ema-agent/storage';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageStatsRoute } from '../src/routes/storage-stats.js';
import type { AppBindings } from '../src/wiring/index.js';

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-backup-route-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function importBindings(
  activeDataDir: string,
  restoreRows: (payload: SessionRestorePayload) => void,
): AppBindings {
  const sessionBackup = new SessionBackupFacade({
    activeDataDir,
    artifactsEnabled: false,
    sessionExists: () => false,
    restoreRows,
    collectExport: () => null,
  });
  return {
    activeDataDir,
    releaseFeatures: { artifacts: false },
    sessionBackup,
    session: {
      getSession: () => ({ id: 'session-1', title: 'Imported' }),
    },
  } as unknown as AppBindings;
}

function sessionZip(sessionId: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ version: '1' })),
    'session.json': strToU8(JSON.stringify({
      id: sessionId, title: 'Imported', workspaceRoot: null,
      createdAt: 1, updatedAt: 1, lastActivityAt: 1,
      archivedAt: null, pinned: false, pinnedAt: null,
      groupLabel: null, parentSessionId: null, lastMode: null,
      activeBranchId: null,
    })),
    ...extra,
  });
}

async function postZip(app: ReturnType<typeof storageStatsRoute>, zip: Uint8Array): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([zip], { type: 'application/zip' }), 'backup.zip');
  return app.request('/sessions/import', { method: 'POST', body: form });
}

describe('SessionBackupFacade 的 Core HTTP 接线', () => {
  it('在统一 Facade 内拒绝 session.json 的路径穿越 ID', async () => {
    const root = tempRoot();
    const restoreRows = vi.fn();
    const response = await postZip(
      storageStatsRoute(importBindings(root, restoreRows)),
      sessionZip('../../profile.db'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_format' });
    expect(restoreRows).not.toHaveBeenCalled();
  });

  it('数据库校验失败后由 Facade 回滚已经复制的共享附件', async () => {
    const root = tempRoot();
    const attachment = new Uint8Array([1, 2, 3]);
    const response = await postZip(
      storageStatsRoute(importBindings(root, () => {
        throw new SessionRestoreValidationError('测试恢复失败');
      })),
      sessionZip('session-1', {
        'attachments/index.json': strToU8(JSON.stringify([{
          id: 'attachment-1', name: 'a.txt', mime: 'text/plain',
          size: attachment.byteLength, turnId: 'turn-1', mtime: 0, createdAt: 1,
        }])),
        'attachments/attachment-1_a.txt': attachment,
      }),
    );
    expect(response.status).toBe(400);
    expect(fs.existsSync(path.join(root, 'sessions', 'session-1'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'attachments', 'attachment-1_a.txt'))).toBe(false);
  });

  it('导出路由只把 Facade 结果映射为 ZIP Response', async () => {
    const root = tempRoot();
    const snapshot: SessionExportSnapshot = {
      session: { id: 'session-123456', title: 'Route Export' },
      turns: [], messages: [], artifacts: [], attachments: [], audio: [],
      notes: null, branches: [], agentTasks: [], agentTaskMessages: [],
      memoryState: null, kbActivations: [], llmTurnMetrics: [],
    };
    const sessionBackup = new SessionBackupFacade({
      activeDataDir: root,
      artifactsEnabled: false,
      sessionExists: () => false,
      restoreRows: vi.fn(),
      collectExport: () => snapshot,
    });
    const app = storageStatsRoute({ sessionBackup } as unknown as AppBindings);

    const response = await app.request('/sessions/session-123456/export', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(entries['manifest.json']).toBeDefined();
  });

  it('把 Facade 的导出预算错误映射为结构化 413', async () => {
    const app = storageStatsRoute({
      sessionBackup: {
        exportSession() {
          throw new SessionExportError('超出同步 ZIP 安全预算');
        },
      },
    } as unknown as AppBindings);

    const response = await app.request('/sessions/session-1/export', { method: 'POST' });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'export_too_large',
      message: '超出同步 ZIP 安全预算',
    });
  });
});
