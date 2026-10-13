import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database, SessionBackupReader, SessionBackupRestorer, SpeechOutputsRepo } from '@ema-agent/storage';
import { SessionBackup } from '../sessionBackup.js';
import { readZip, writeZip } from './zipFixtures.js';

const roots: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-backup-files-'));
  roots.push(root);
  const sourceDir = path.join(root, 'source');
  const targetDir = path.join(root, 'target');
  const sourceDb = new Database({ memory: true, kind: 'data' });
  const targetDb = new Database({ memory: true, kind: 'data' });
  databases.push(sourceDb, targetDb);
  sourceDb.migrate();
  targetDb.migrate();
  sourceDb.sqlite.prepare(`
    INSERT INTO sessions (id, title, cwd, last_activity_at, created_at, updated_at)
    VALUES ('session', '会话', 'D:/work', 1, 1, 1)
  `).run();
  sourceDb.sqlite.prepare(`
    INSERT INTO turns (id, session_id, status, trigger_type, created_at)
    VALUES ('turn', 'session', 'completed', 'userMessage', 1)
  `).run();
  const restorer = new SessionBackupRestorer(targetDb.sqlite);
  const source = new SessionBackup(
    sourceDir, new SessionBackupReader(sourceDb.sqlite), new SessionBackupRestorer(sourceDb.sqlite), () => true,
  );
  const target = new SessionBackup(targetDir, new SessionBackupReader(targetDb.sqlite), restorer, () => true);
  return { root, sourceDir, targetDir, sourceDb, targetDb, restorer, source, target, zipPath: path.join(root, '会话.zip') };
}

function addSpeech(data: ReturnType<typeof fixture>, characterName: string): string {
  const storagePath = path.join(data.sourceDir, 'sessions', 'session', 'audio', 'turn', `turn-${characterName}.wav`);
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.writeFileSync(storagePath, Buffer.from([1, 2, 3, 4]));
  new SpeechOutputsRepo(data.sourceDb.sqlite).record({
    turnId: 'turn', sessionId: 'session', storagePath, mimeType: 'audio/wav',
    byteSize: 4, durationMs: 1500, createdAt: 1,
  });
  return storagePath;
}

describe('SessionBackup', () => {
  it('启动时清理临时目录, 不存在的会话返回明确错误而不生成 ZIP', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-session-backup-'));
    roots.push(dataDir);
    const stale = path.join(dataDir, '.backup-temp', 'imports', 'stale');
    fs.mkdirSync(stale, { recursive: true });

    const reader = { readSession: vi.fn(() => null) } as unknown as SessionBackupReader;
    const restorer = {} as SessionBackupRestorer;
    const backup = new SessionBackup(dataDir, reader, restorer, () => false);

    expect(fs.existsSync(stale)).toBe(false);
    const filePath = path.join(dataDir, 'missing.zip');
    await expect(backup.exportSession('missing', filePath))
      .rejects.toMatchObject({ code: 'session_not_found', status: 404 });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.readdirSync(path.join(dataDir, '.backup-temp', 'exports'))).toEqual([]);
  });

  it('按路径导出和导入同轮不同角色的正式音频, 时长和原文件内容保留', async () => {
    const data = fixture();
    addSpeech(data, '艾玛');
    addSpeech(data, '另一角色');
    const exported = await data.source.exportSession('session', data.zipPath);
    expect(exported).toEqual({ filePath: data.zipPath, warnings: [] });
    expect(fs.existsSync(exported.filePath)).toBe(true);
    await expect(data.target.importSession(data.zipPath)).resolves.toEqual({ sessionId: 'session', warnings: [] });
    const outputs = new SpeechOutputsRepo(data.targetDb.sqlite).listForTurn('turn');
    expect(outputs).toHaveLength(2);
    for (const output of outputs) {
      expect(output.duration_ms).toBe(1500);
      expect(output.mime_type).toBe('audio/wav');
      expect(output.storage_path.startsWith(data.targetDir)).toBe(true);
      expect(fs.readFileSync(output.storage_path)).toEqual(Buffer.from([1, 2, 3, 4]));
    }
    expect(fs.readdirSync(path.join(data.sourceDir, '.backup-temp', 'exports'))).toEqual([]);
    expect(fs.readdirSync(path.join(data.targetDir, '.backup-temp', 'imports'))).toEqual([]);
  });

  it('记录存在但文件缺失时仍导出, 导出和导入都带警告', async () => {
    const data = fixture();
    const speechPath = addSpeech(data, '艾玛');
    fs.unlinkSync(speechPath);
    const exported = await data.source.exportSession('session', data.zipPath);
    expect(exported.warnings).toEqual(['speechOutput:turn 未包含文件内容']);
    const imported = await data.target.importSession(data.zipPath);
    expect(imported.warnings).toEqual(exported.warnings);
    expect(new SpeechOutputsRepo(data.targetDb.sqlite).listForTurn('turn')).toEqual([]);
  });

  it('同 ID 会话导入冲突时不覆盖原数据', async () => {
    const data = fixture();
    await data.source.exportSession('session', data.zipPath);
    await expect(data.source.importSession(data.zipPath))
      .rejects.toMatchObject({ code: 'destination_conflict', status: 409 });
    expect(data.sourceDb.sqlite.prepare('SELECT title FROM sessions').all()).toEqual([{ title: '会话' }]);
  });

  it('复制资源中途失败时不把部分文件放进 ZIP, 并返回缺失警告', async () => {
    const data = fixture();
    addSpeech(data, '艾玛');
    const copied = vi.spyOn(fs, 'copyFileSync').mockImplementationOnce((_source, destination) => {
      fs.writeFileSync(destination, Buffer.from([1, 2]));
      throw new Error('模拟资源复制中断');
    });
    const exported = await data.source.exportSession('session', data.zipPath);
    expect(exported.warnings).toEqual(['speechOutput:turn 未包含文件内容']);
    expect(copied.mock.calls).toHaveLength(1);
    const entries = await readZip(data.zipPath);
    expect(entries.get('files/speechOutputs/turn/turn-艾玛.wav')).toBeUndefined();
    await expect(data.target.importSession(data.zipPath))
      .resolves.toEqual({ sessionId: 'session', warnings: exported.warnings });
    expect(new SpeechOutputsRepo(data.targetDb.sqlite).listForTurn('turn')).toEqual([]);
  });

  it('写入失败不破坏所选位置的已有备份, 也不留下半个 ZIP', async () => {
    const data = fixture();
    fs.writeFileSync(data.zipPath, 'previous backup');
    const open = fs.createWriteStream;
    vi.spyOn(fs, 'createWriteStream').mockImplementationOnce((...args) => {
      const output = open(...args);
      output.once('pipe', () => output.destroy(new Error('模拟磁盘写入失败')));
      return output;
    });
    await expect(data.source.exportSession('session', data.zipPath))
      .rejects.toMatchObject({ code: 'export_failed', message: '模拟磁盘写入失败' });
    expect(fs.readFileSync(data.zipPath, 'utf8')).toBe('previous backup');
    expect(fs.readdirSync(data.root).some(name => name.startsWith('.ema-session-export-'))).toBe(false);
    expect(fs.readdirSync(path.join(data.sourceDir, '.backup-temp', 'exports'))).toEqual([]);
  });

  it('取消写入时关闭文件并保留已有备份', async () => {
    const data = fixture();
    fs.writeFileSync(data.zipPath, 'previous backup');
    const controller = new AbortController();
    const open = fs.createWriteStream;
    vi.spyOn(fs, 'createWriteStream').mockImplementationOnce((...args) => {
      const output = open(...args);
      output.once('pipe', () => controller.abort());
      return output;
    });
    await expect(data.source.exportSession('session', data.zipPath, controller.signal))
      .rejects.toMatchObject({ code: 'export_cancelled', status: 499 });
    expect(fs.readFileSync(data.zipPath, 'utf8')).toBe('previous backup');
    expect(fs.readdirSync(data.root).some(name => name.startsWith('.ema-session-export-'))).toBe(false);
  });

  it('用户选中的已有备份只在新 ZIP 完成后替换', async () => {
    const data = fixture();
    fs.writeFileSync(data.zipPath, 'previous backup');
    await data.source.exportSession('session', data.zipPath);
    await expect(data.target.importSession(data.zipPath)).resolves.toMatchObject({ sessionId: 'session' });
  });

  it('数据库恢复失败时删除已经发布的会话文件, 不留下正式行', async () => {
    const data = fixture();
    addSpeech(data, '艾玛');
    await data.source.exportSession('session', data.zipPath);
    vi.spyOn(data.restorer, 'restoreSession').mockImplementationOnce(() => {
      throw new Error('模拟数据库失败');
    });
    await expect(data.target.importSession(data.zipPath))
      .rejects.toMatchObject({ code: 'restore_failed', message: '模拟数据库失败' });
    expect(data.targetDb.sqlite.prepare('SELECT id FROM sessions').all()).toEqual([]);
    expect(fs.readdirSync(path.join(data.targetDir, 'sessions'))).toEqual([]);
    expect(fs.readdirSync(path.join(data.targetDir, '.backup-temp', 'imports'))).toEqual([]);
  });

  it('归档中的会话 ID 不得让恢复目录越界', async () => {
    const data = fixture();
    await data.source.exportSession('session', data.zipPath);
    const entries = await readZip(data.zipPath);
    entries.set('manifest.json', Buffer.from(JSON.stringify({ sessionId: '../outside', omittedFiles: [] })));
    const session = JSON.parse(entries.get('records/session.json')!.toString('utf8'));
    session.id = '../outside';
    entries.set('records/session.json', Buffer.from(JSON.stringify(session)));
    entries.set('records/turns.jsonl', Buffer.from(''));
    const invalidPath = path.join(data.root, 'invalid.zip');
    await writeZip(invalidPath, entries);
    await expect(data.target.importSession(invalidPath))
      .rejects.toMatchObject({ code: 'unsafe_archive_path' });
    expect(fs.existsSync(path.join(data.targetDir, 'outside'))).toBe(false);
    expect(data.targetDb.sqlite.prepare('SELECT id FROM sessions').all()).toEqual([]);
  });
});
