// 全链路往返:带附件的 Session 导出 ZIP -> 导入另一个数据目录,
// 验证文件落位、两本账行(盖章保留)与消息块内路径前缀重写。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AttachmentImagesRepo,
  AttachmentPastedTextsRepo,
  Database,
  SessionBackupReader,
  SessionBackupRestorer,
  UsageRecordsRepo,
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
    INSERT INTO sessions (id, title, cwd, pinned, last_activity_at, created_at, updated_at, permission_mode)
    VALUES (?, '往返', 'D:/work', 0, 1, 1, 1, 'plan')
  `).run(SESSION_ID);
  db.sqlite.prepare(`
    INSERT INTO turns (id, session_id, trigger_type, session_mode, narrative_policy,
      tts_enabled, character_name, status, created_at)
    VALUES ('t1', ?, 'userMessage', 'chat', 'off', 1, 'ema', 'completed', 1)
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
  db.sqlite.prepare(`
    INSERT INTO messages (
      id, session_id, role, kind, blocks_json, created_at,
      summarized_through_message_id, summary_saved_tokens
    ) VALUES ('summary-1', ?, 'user', 'summary', '"summary"', 3, 'm1', 12345)
  `).run(SESSION_ID);
  db.sqlite.prepare(`
    INSERT INTO goals (
      id, session_id, objective, feedback, status, version, reason, error,
      created_at, updated_at, completed_at
    ) VALUES ('goal-completed', ?, '整理全部文件', '已读 8/8', 'completed', 5,
      'succeeded', NULL, 2, 6, 6)
  `).run(SESSION_ID);

  new AttachmentImagesRepo(db.sqlite).insertMany([{
    path: imagePath, session_id: SESSION_ID, name: '猫.png', byte_size: 4, created_at: 1,
  }]);
  new AttachmentPastedTextsRepo(db.sqlite).insert({
    path: pastedPath, session_id: SESSION_ID, byte_size: 12, created_at: 1,
  });
  new AttachmentImagesRepo(db.sqlite).claimForTurn(SESSION_ID, 't1', [imagePath]);
  new AttachmentPastedTextsRepo(db.sqlite).claimForTurn(SESSION_ID, 't1', [pastedPath]);
  new UsageRecordsRepo(db.sqlite).record({
    id: 'llm-call-1',
    session_id: SESSION_ID,
    turn_id: 't1',
    provider_id: 'provider',
    model_id: 'model',
    capability: 'llm',
    status: 'completed',
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: null,
    cache_write_input_tokens: null,
    quantity: null,
    unit: null,
    duration_ms: 50,
    error_code: null,
    created_at: 2,
  });
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
    expect(targetDb.sqlite.prepare('SELECT permission_mode FROM sessions WHERE id = ?').get(SESSION_ID))
      .toEqual({ permission_mode: 'plan' });
    expect(targetDb.sqlite.prepare('SELECT summary_saved_tokens FROM messages WHERE id = ?')
      .get('summary-1')).toEqual({ summary_saved_tokens: 12_345 });
    expect(targetDb.sqlite.prepare("SELECT tts_enabled FROM turns WHERE id = 't1'").get())
      .toMatchObject({ tts_enabled: 1 });
    expect(targetDb.sqlite.prepare("SELECT character_name FROM turns WHERE id = 't1'").get())
      .toMatchObject({ character_name: 'ema' });
    expect(targetDb.sqlite.prepare('SELECT * FROM goals WHERE id = ?').get('goal-completed'))
      .toMatchObject({
        session_id: SESSION_ID,
        objective: '整理全部文件',
        feedback: '已读 8/8',
        status: 'completed',
        version: 5,
        reason: 'succeeded',
        completed_at: 6,
      });

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
    expect(new UsageRecordsRepo(targetDb.sqlite).forTurn('t1')).toEqual([
      expect.objectContaining({
        id: 'llm-call-1',
        input_tokens: 100,
        output_tokens: 20,
      }),
    ]);

    targetDb.close();
  });

  it('导入仍在执行的 Goal 时暂停, 保留身份、正文和反馈', async () => {
    const sourceDir = tempDir('ema-backup-goal-src-');
    const targetDir = tempDir('ema-backup-goal-dst-');
    const workDir = tempDir('ema-backup-goal-work-');
    const sourceDb = seedSource(sourceDir);
    sourceDb.sqlite.prepare("UPDATE sessions SET permission_mode = 'default' WHERE id = ?")
      .run(SESSION_ID);
    sourceDb.sqlite.prepare(`
      INSERT INTO goals (
        id, session_id, objective, feedback, status, version, reason, error,
        created_at, updated_at, completed_at
      ) VALUES ('goal-active', ?, '读取剩余文件', '已读 2/8', 'active', 3,
        NULL, NULL, 3, 5, NULL)
    `).run(SESSION_ID);

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

    const targetDb = new Database({ memory: true, kind: 'data' });
    targetDb.migrate();
    const zipBytes = Buffer.concat(chunks);
    await importSessionArchive(
      { declaredBytes: zipBytes.byteLength, async *chunks() { yield zipBytes; } },
      targetDir,
      workDir,
      new SessionBackupReader(targetDb.sqlite),
      new SessionBackupRestorer(targetDb.sqlite),
      () => true,
    );
    expect(targetDb.sqlite.prepare('SELECT * FROM goals WHERE id = ?').get('goal-active'))
      .toMatchObject({
        session_id: SESSION_ID,
        objective: '读取剩余文件',
        feedback: '已读 2/8',
        status: 'paused',
        version: 4,
        reason: null,
        error: null,
        completed_at: null,
      });
    targetDb.close();
  });

  it('仍能导入没有 Goal 记录的 v5 归档', async () => {
    const sourceDir = tempDir('ema-backup-v5-src-');
    const targetDir = tempDir('ema-backup-v5-dst-');
    const workDir = tempDir('ema-backup-v5-work-');
    const sourceDb = seedSource(sourceDir);
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

    const entries = unzipSync(Buffer.concat(chunks));
    const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as { version: number };
    manifest.version = 5;
    entries['manifest.json'] = strToU8(JSON.stringify(manifest));
    delete entries['records/goals.jsonl'];
    const zipBytes = Buffer.from(zipSync(entries));

    const targetDb = new Database({ memory: true, kind: 'data' });
    targetDb.migrate();
    await importSessionArchive(
      { declaredBytes: zipBytes.byteLength, async *chunks() { yield zipBytes; } },
      targetDir,
      workDir,
      new SessionBackupReader(targetDb.sqlite),
      new SessionBackupRestorer(targetDb.sqlite),
      () => true,
    );
    expect(targetDb.sqlite.prepare('SELECT id FROM goals WHERE session_id = ?').all(SESSION_ID))
      .toEqual([]);
    targetDb.close();
  });
});
