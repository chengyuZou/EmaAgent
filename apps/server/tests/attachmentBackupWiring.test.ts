// 测试 LocalHost 的附件惰性对象图与动态缓存配额。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ATTACHMENT_SETTINGS,
  attachmentSetting,
} from '@ema-agent/attachment';
import { SettingsStore } from '@ema-agent/settings';
import {
  Database,
  SettingsRepo,
} from '@ema-agent/storage';
import { createAttachmentRuntime } from '../src/wiring/createAttachmentRuntime.js';
import { createSessionPersistence } from '../src/wiring/createSessionPersistence.js';

const databases: Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Attachment runtime wiring', () => {
  it('构造阶段不创建缓存目录，并在真正清理时读取最新设置', async () => {
    const profileDb = openDatabase('profile');
    const dataDb = openDatabase('data');
    const activeDataDir = temporaryDirectory('ema-attachment-runtime-');
    const persistence = createSessionPersistence(dataDb, activeDataDir);
    const settings = new SettingsStore(new SettingsRepo(profileDb.sqlite));
    const getSetting = vi.spyOn(settings, 'get');

    const runtime = createAttachmentRuntime(
      dataDb,
      activeDataDir,
      persistence.session,
      settings,
    );

    expect(getSetting).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(activeDataDir, 'attachments', 'vision-cache')))
      .toBe(false);

    settings.set(attachmentSetting, {
      ...DEFAULT_ATTACHMENT_SETTINGS,
      derivationCacheBytes: 64 * 1024 * 1024,
    });
    const report = await runtime.attachmentCacheMaintenance.sweepIfIdle(
      6 * 60 * 60 * 1_000 + 1,
    );

    expect(report.ran).toBe(true);
    expect(getSetting).toHaveBeenCalledTimes(1);
    expect(getSetting).toHaveBeenCalledWith(attachmentSetting);
  });
});

function openDatabase(kind: 'profile' | 'data'): Database {
  const database = new Database({ memory: true, kind });
  database.migrate();
  databases.push(database);
  return database;
}

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
