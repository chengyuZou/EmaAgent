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
  UsageRecordsRepo,
} from '@ema-agent/storage';
import { exportSessionArchive } from '../export/sessionExport.js';
import { importSessionArchive } from '../import/sessionImport.js';
import { readZip, writeZip } from './zipFixtures.js';

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
    INSERT INTO turns (id, session_id, trigger_type,
      tts_enabled, character_name, status, created_at)
    VALUES ('t1', ?, 'userMessage', 1, 'ema', 'completed', 1)
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
  it('ZIP 写完后导入:文件落新目录,附件归属保留,块内路径前缀重写', async () => {
    const sourceDir = tempDir('ema-backup-src-');
    const targetDir = tempDir('ema-backup-dst-');
    const workDir = tempDir('ema-backup-work-');
    const sourceDb = seedSource(sourceDir);

    const zipPath = path.join(workDir, '会话备份.zip');
    const exported = await exportSessionArchive(
      SESSION_ID, zipPath, sourceDir, workDir, new SessionBackupReader(sourceDb.sqlite),
    );
    sourceDb.close();
    expect(exported).toEqual({ filePath: zipPath, warnings: [] });
    expect(fs.statSync(zipPath).size).toBeGreaterThan(100);
    const entries = await readZip(zipPath);
    expect(JSON.parse(entries.get('manifest.json')!.toString('utf8'))).toEqual({
      sessionId: SESSION_ID,
      omittedFiles: [],
    });

    // 导入到另一个数据目录
    const targetDb = new Database({ memory: true, kind: 'data' });
    targetDb.migrate();
    const result = await importSessionArchive(
      zipPath,
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

    // 附件记录使用新 path 主键, 保留原 Turn 归属.
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

    const zipPath = path.join(workDir, 'goal.zip');
    await exportSessionArchive(
      SESSION_ID, zipPath, sourceDir, workDir, new SessionBackupReader(sourceDb.sqlite),
    );
    sourceDb.close();

    const targetDb = new Database({ memory: true, kind: 'data' });
    targetDb.migrate();
    await importSessionArchive(
      zipPath,
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

  it('缺少当前必需的记录文件时拒绝导入, 不发布文件或留下数据库行', async () => {
    const sourceDir = tempDir('ema-backup-invalid-src-');
    const targetDir = tempDir('ema-backup-invalid-dst-');
    const workDir = tempDir('ema-backup-invalid-work-');
    const sourceDb = seedSource(sourceDir);
    const zipPath = path.join(workDir, 'valid.zip');
    await exportSessionArchive(
      SESSION_ID, zipPath, sourceDir, workDir, new SessionBackupReader(sourceDb.sqlite),
    );
    sourceDb.close();

    const entries = await readZip(zipPath);
    entries.delete('records/goals.jsonl');
    const invalidPath = path.join(workDir, 'invalid.zip');
    await writeZip(invalidPath, entries);

    const targetDb = new Database({ memory: true, kind: 'data' });
    targetDb.migrate();
    await expect(importSessionArchive(
      invalidPath,
      targetDir,
      workDir,
      new SessionBackupReader(targetDb.sqlite),
      new SessionBackupRestorer(targetDb.sqlite),
      () => true,
    )).rejects.toMatchObject({ code: 'invalid_format' });
    expect(targetDb.sqlite.prepare('SELECT id FROM sessions').all())
      .toEqual([]);
    expect(fs.existsSync(path.join(targetDir, 'sessions', SESSION_ID))).toBe(false);
    targetDb.close();
  });
});
