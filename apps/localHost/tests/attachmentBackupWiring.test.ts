// 测试 LocalHost 的附件惰性对象图、动态缓存配额与 Session 备份投影。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
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
import { createSessionBackup } from '../src/wiring/createSessionBackup.js';
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

describe('Session backup wiring', () => {
  it('从同一 Session 对象图导出消息、附件文件和会话笔记', () => {
    const profileDb = openDatabase('profile');
    const dataDb = openDatabase('data');
    const activeDataDir = temporaryDirectory('ema-session-backup-');
    const persistence = createSessionPersistence(dataDb, activeDataDir);
    const settings = new SettingsStore(new SettingsRepo(profileDb.sqlite));
    const attachments = createAttachmentRuntime(
      dataDb,
      activeDataDir,
      persistence.session,
      settings,
    );
    const created = persistence.session.createSession({ title: 'Wiring Backup' });
    const { turn } = persistence.session.startTurn({
      sessionId: created.id,
      triggerType: 'userMessage',
      executionProfile: 'chat',
      narrativePolicy: 'off',
      userInput: '请保留这些证据',
    });
    persistence.session.appendMessage({
      sessionId: created.id,
      turnId: turn.id,
      role: 'user',
      blocks: '请保留这些证据',
    });

    const attachmentPath = path.join(activeDataDir, 'evidence.txt');
    fs.writeFileSync(attachmentPath, 'attachment evidence', 'utf8');
    const attachmentStat = fs.statSync(attachmentPath);
    attachments.attachmentStore.add({
      id: 'attachment-wiring',
      name: 'evidence.txt',
      mimeType: 'text/plain',
      size: attachmentStat.size,
      mtime: attachmentStat.mtimeMs,
      localPath: attachmentPath,
    }, turn.id, created.id);
    persistence.session.completeTurn(turn.id);
    persistence.sessionNotes.upsert({
      sessionId: created.id,
      body: '跨 Turn 会话笔记',
      tokensAtLastUpdate: 6,
      updatedAt: 2,
    });

    const backup = createSessionBackup(
      activeDataDir,
      persistence.session,
      persistence.sessionStats,
      persistence.sessionNotes,
      attachments.attachmentStore,
    );
    const exported = backup.exportSession({ sessionId: created.id });

    expect(exported).not.toBeNull();
    const entries = unzipSync(exported!.bytes);
    const messages = JSON.parse(strFromU8(entries['messages.json']!)) as unknown[];
    const attachmentIndex = JSON.parse(
      strFromU8(entries['attachments/index.json']!),
    ) as Array<{ id: string }>;
    const notes = JSON.parse(strFromU8(entries['notes.json']!)) as {
      body: string;
    };

    expect(messages).toHaveLength(1);
    expect(attachmentIndex).toEqual([
      expect.objectContaining({ id: 'attachment-wiring' }),
    ]);
    expect(entries['attachments/attachment-wiring_evidence.txt']).toBeDefined();
    expect(notes.body).toBe('跨 Turn 会话笔记');
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
