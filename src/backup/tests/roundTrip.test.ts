// 全链路往返:带附件的 Session 导出 ZIP -> 导入另一个数据目录,
// 验证文件落位、两本账行(盖章保留)与消息块内路径前缀重写。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AttachmentImagesRepo,
  AttachmentPastedTextsRepo,
  Database,
  SessionBackupReader,
  SessionBackupRestorer,
} from '@ema-agent/storage';
import { createSessionExport } from '../export/sessionExport.js';
import { importSessionArchive } from '../import/sessionImport.js';
import type { BackupArchiveSource } from '../types.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const SESSION_ID = 's-roundtrip';

function seedSource(dataDir: string): Database {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  db.sqlite.prepare(`
    INSERT INTO sessions (id, title, pinned, last_activity_at, created_at, updated_at)
    VALUES (?, '往返', 0, 1, 1, 1)
  `).run(SESSION_ID);
  db.sqlite.prepare(`
    INSERT INTO turns (id, session_id, trigger_type, execution_profile, narrative_policy,
      status, created_at)
    VALUES ('t1', ?, 'userMessage', 'chat', 'off', 'completed', 1)
  `).run(SESSION_ID);

  const imagePath = path.join(dataDir, 'sessions', SESSION_ID, 'attachments', 'images', 'u1.png');
  const pastedPath = path.join(dataDir, 'sessions', SESSION_ID, 'attachments', 'pasted', 'u2.txt');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.mkdirSync(path.dirname(pastedPath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(pastedPath, '粘贴全文');

  const blocks = JSON.stringify([
    { type: 'image_reference', path: imagePath, name: '猫.png' },
    { type: 'pasted_text_reference', path: pastedPath, preview: '粘贴全文' },
    { type: 'file_reference', path: 'D:/docs/map.pdf' },
    { type: 'text', text: '看这三个' },
  ]);
  db.sqlite.prepare(`
    INSERT INTO messages (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at)
    VALUES ('m1', ?, 't1', 'user', 'normal', ?, 0, 2)
  `).run(SESSION_ID, blocks);

  new AttachmentImagesRepo(db.sqlite).insertMany([{
    path: imagePath, session_id: SESSION_ID, name: '猫.png', byte_size: 4, created_at: 1,
  }]);
  new AttachmentPastedTextsRepo(db.sqlite).insert({
    path: pastedPath, session_id: SESSION_ID, byte_size: 12, created_at: 1,
  });
  new AttachmentImagesRepo(db.sqlite).claimForTurn(SESSION_ID, 't1', [imagePath]);
  new AttachmentPastedTextsRepo(db.sqlite).claimForTurn(SESSION_ID, 't1', [pastedPath]);
  return db;
}

describe('Session 备份往返', () => {
  it('导出再导入:文件落新目录,账本盖章保留,块内路径前缀重写', async () => {
    const sourceDir = tempDir('ema-backup-src-');
    const targetDir = tempDir('ema-backup-dst-');
    const workDir = tempDir('ema-backup-work-');
    const sourceDb = seedSource(sourceDir);

    // 导出到内存字节
    const chunks: Buffer[] = [];
    const sessionExport = createSessionExport(
      SESSION_ID, sourceDir, workDir, new SessionBackupReader(sourceDb.sqlite),
    );
    expect(sessionExport).not.toBeNull();
    await sessionExport!.writeTo({
      write: async chunk => { chunks.push(Buffer.from(chunk)); },
      complete: async () => {},
      fail: async reason => { throw reason instanceof Error ? reason : new Error(String(reason)); },
    });
    sourceDb.close();
    const zipBytes = Buffer.concat(chunks);
    expect(zipBytes.byteLength).toBeGreaterThan(100);

    // 导入到另一个数据目录
    const targetDb = new Database({ memory: true, kind: 'data' });
    targetDb.migrate();
    const source: BackupArchiveSource = {
      declaredBytes: zipBytes.byteLength,
      async *chunks() { yield zipBytes; },
    };
    const result = await importSessionArchive(
      source,
      targetDir,
      workDir,
      new SessionBackupReader(targetDb.sqlite),
      new SessionBackupRestorer(targetDb.sqlite),
      () => true,
    );
    expect(result.sessionId).toBe(SESSION_ID);

    // 新路径:uuid 文件名不变,数据根前缀换成目标目录
    const newImagePath = path.join(targetDir, 'sessions', SESSION_ID, 'attachments', 'images', 'u1.png');
    const newPastedPath = path.join(targetDir, 'sessions', SESSION_ID, 'attachments', 'pasted', 'u2.txt');
    expect(fs.readFileSync(newImagePath)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(fs.readFileSync(newPastedPath, 'utf8')).toBe('粘贴全文');

    // 账本行:新 path 主键,盖章保留
    const imageRow = new AttachmentImagesRepo(targetDb.sqlite).listBySession(SESSION_ID)[0];
    expect(imageRow?.path).toBe(newImagePath);
    expect(imageRow?.turn_id).toBe('t1');
    expect(imageRow?.name).toBe('猫.png');
    const pastedRow = new AttachmentPastedTextsRepo(targetDb.sqlite).listBySession(SESSION_ID)[0];
    expect(pastedRow?.path).toBe(newPastedPath);
    expect(pastedRow?.turn_id).toBe('t1');

    // 块内路径:受管路径被重写,用户文件原路径不动
    const message = targetDb.sqlite.prepare(
      `SELECT blocks_json FROM messages WHERE id = 'm1'`,
    ).get() as { blocks_json: string };
    const blocks = JSON.parse(message.blocks_json) as Array<{ type: string; path: string }>;
    const imageBlock = blocks.find(b => b.type === 'image_reference')!;
    const pastedBlock = blocks.find(b => b.type === 'pasted_text_reference')!;
    const fileBlock = blocks.find(b => b.type === 'file_reference')!;
    expect(imageBlock.path).toBe(newImagePath);
    expect(pastedBlock.path).toBe(newPastedPath);
    expect(fileBlock.path).toBe('D:/docs/map.pdf');

    targetDb.close();
  });
});
