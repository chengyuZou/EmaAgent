// 验证 Backup 顶层入口只暴露单 Session 操作并在构造时清理遗留临时文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionBackupReader, SessionBackupRestorer } from '@ema-agent/storage';
import { SessionBackup } from '../sessionBackup.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('SessionBackup', () => {
  it('启动时删除上次遗留的导入导出目录', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-session-backup-'));
    roots.push(dataDir);
    const stale = path.join(dataDir, '.backup-temp', 'imports', 'stale');
    fs.mkdirSync(stale, { recursive: true });

    const reader = { hasSession: vi.fn(() => false) } as unknown as SessionBackupReader;
    const restorer = {} as SessionBackupRestorer;
    const backup = new SessionBackup(dataDir, reader, restorer, () => false);

    expect(fs.existsSync(stale)).toBe(false);
    expect(backup.exportSession('missing')).toBeNull();
  });
});
