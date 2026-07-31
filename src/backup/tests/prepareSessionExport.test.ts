// 验证导出 staging 在事务外冻结文件、写齐必需记录，并把缺失文件降级为安全 warning。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database, SessionBackupReader } from '@ema-agent/storage';
import { prepareSessionExport } from '../export/prepareSessionExport.js';
import { BACKUP_RECORD_REGISTRY } from '../records/recordRegistry.js';

describe('prepareSessionExport', () => {
  const roots: string[] = [];
  const databases: Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('冻结记录与存在的附件，并对缺失附件只记录 warning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ema-backup-stage-test-'));
    roots.push(root);
    const database = new Database({ path: join(root, 'data.db'), kind: 'data' });
    databases.push(database);
    database.migrate();
    database.sqlite.prepare(
      `INSERT INTO sessions (id, title, created_at, updated_at, last_activity_at)
       VALUES ('session-a', 'A', 1, 1, 1)`,
    ).run();
    database.sqlite.prepare(
      `INSERT INTO turns (
         id, session_id, trigger_type, execution_profile, narrative_policy,
         status, user_input, started_at
       ) VALUES ('turn-a', 'session-a', 'userMessage', 'chat', 'auto', 'completed', 'hi', 2)`,
    ).run();
    const existing = join(root, 'attachment.txt');
    writeFileSync(existing, 'hello');
    const insertAttachment = database.sqlite.prepare(
      `INSERT INTO turn_attachments
         (id, turn_id, session_id, name, mime, size, mtime, local_path, created_at)
       VALUES (?, 'turn-a', 'session-a', ?, 'text/plain', ?, 1, ?, 3)`,
    );
    insertAttachment.run('attachment-ok', 'hello.txt', 5, existing);
    insertAttachment.run('attachment-missing', 'missing.txt', 1, join(root, 'missing.txt'));

    const prepared = prepareSessionExport(
      new SessionBackupReader(database.sqlite),
      { sessionId: 'session-a', activeDataDir: root, generator: 'test', stagingRoot: root },
    );
    expect(prepared).not.toBeNull();

    const paths: string[] = [];
    for await (const entry of prepared!.entries()) paths.push(entry.path);
    expect(
      BACKUP_RECORD_REGISTRY
        .filter(definition => definition.required)
        .every(definition => paths.includes(definition.archivePath)),
    ).toBe(true);
    expect(paths).toContain('files/attachments/attachment-ok/hello.txt');
    expect(paths).not.toContain('files/attachments/attachment-missing/missing.txt');
    expect(prepared!.manifest.warnings).toEqual([
      { kind: 'attachment', id: 'attachment-missing', reason: 'missing' },
    ]);
    prepared!.dispose();
  });
});
