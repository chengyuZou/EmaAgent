import fs from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { hc } from 'hono/client';
import { serve } from '@hono/node-server';
import { SessionBackup } from '@ema-agent/backup';
import { Database, SessionBackupReader, SessionBackupRestorer } from '@ema-agent/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestBudgetMiddleware, resolveRequestBudget } from '../../../platform/requestBudget.js';
import { sessionBackupRoute } from '../sessions.js';

let root: string;
let sourceDb: Database;
let targetDb: Database;
let source: ReturnType<typeof createApp>;
let target: ReturnType<typeof createApp>;
const onImported = vi.fn();

function createApp(dataDir: string, database: Database) {
  const backup = new SessionBackup(
    dataDir,
    new SessionBackupReader(database.sqlite),
    new SessionBackupRestorer(database.sqlite),
    () => true,
  );
  return new Hono()
    .use('*', requestBudgetMiddleware())
    .route('/api/sessions', sessionBackupRoute({ backup, onImported }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-backup-route-'));
  sourceDb = new Database({ memory: true, kind: 'data' });
  targetDb = new Database({ memory: true, kind: 'data' });
  sourceDb.migrate();
  targetDb.migrate();
  sourceDb.sqlite.prepare(`
    INSERT INTO sessions (id, title, cwd, last_activity_at, created_at, updated_at)
    VALUES ('session', '会话备份', 'D:/work', 1, 1, 1)
  `).run();
  source = createApp(path.join(root, 'source'), sourceDb);
  target = createApp(path.join(root, 'target'), targetDb);
  onImported.mockClear();
});

afterEach(() => {
  sourceDb.close();
  targetDb.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function postJson(app: typeof source, url: string, body: { destinationPath: string } | { filePath: string }) {
  return app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('会话备份路径请求', () => {
  it('经真实本机 HTTP 和类型化客户端完成 ZIP 保存与导入', async () => {
    const app = new Hono()
      .route('/source', source)
      .route('/target', target);
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sourceClient = hc<typeof source>(`${baseUrl}/source`);
    const targetClient = hc<typeof target>(`${baseUrl}/target`);
    try {
      const zipPath = path.join(root, 'HTTP 备份.zip');
      const exported = await sourceClient.api.sessions[':sessionId'].export.$post({
        param: { sessionId: 'session' },
        json: { destinationPath: zipPath },
      });
      expect(exported.status).toBe(200);
      expect(await exported.json()).toEqual({ filePath: zipPath, warnings: [] });
      expect(fs.statSync(zipPath).size).toBeGreaterThan(100);
      const imported = await targetClient.api.sessions.import.$post({ json: { filePath: zipPath } });
      expect(imported.status).toBe(201);
      expect(await imported.json()).toEqual({ sessionId: 'session', warnings: [] });
      expect(targetDb.sqlite.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'session' }]);
      expect(onImported).toHaveBeenCalledWith('session');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((cause?: Error) => {
          if (cause) {
            reject(cause);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it('导出返回时 ZIP 已保存, 导入按路径恢复会话并发送带 ID 的事件', async () => {
    const zipPath = path.join(root, '备份.zip');
    const exported = await postJson(source, '/api/sessions/session/export', { destinationPath: zipPath });
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toContain('application/json');
    expect(exported.headers.get('content-disposition')).toBeNull();
    expect(await exported.json()).toEqual({ filePath: zipPath, warnings: [] });
    expect(fs.statSync(zipPath).size).toBeGreaterThan(100);
    expect(onImported).not.toHaveBeenCalled();

    const imported = await postJson(target, '/api/sessions/import', { filePath: zipPath });
    expect(imported.status).toBe(201);
    expect(await imported.json()).toEqual({ sessionId: 'session', warnings: [] });
    expect(targetDb.sqlite.prepare('SELECT id, title FROM sessions').all()).toEqual([
      { id: 'session', title: '会话备份' },
    ]);
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported).toHaveBeenCalledWith('session');
  });

  it('不存在的会话返回 404, 不生成文件', async () => {
    const zipPath = path.join(root, 'missing.zip');
    const response = await postJson(source, '/api/sessions/missing/export', { destinationPath: zipPath });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'session_not_found', message: 'Session 不存在' });
    expect(fs.existsSync(zipPath)).toBe(false);
  });

  it('无法写入选择的位置时返回错误, 而不是下载成功', async () => {
    const zipPath = path.join(root, 'not-existing', 'backup.zip');
    const response = await postJson(source, '/api/sessions/session/export', { destinationPath: zipPath });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'export_failed', message: expect.any(String) });
    expect(fs.existsSync(zipPath)).toBe(false);
  });

  it('相对路径在文件操作前被拒绝', async () => {
    const exported = await postJson(source, '/api/sessions/session/export', { destinationPath: 'backup.zip' });
    const imported = await postJson(target, '/api/sessions/import', { filePath: 'backup.zip' });
    expect(exported.status).toBe(400);
    expect(imported.status).toBe(400);
    expect(await exported.json()).toMatchObject({ error: 'invalid_request' });
    expect(await imported.json()).toMatchObject({ error: 'invalid_request' });
    expect(onImported).not.toHaveBeenCalled();
  });

  it('导入冲突不覆盖原会话, 不发送成功事件', async () => {
    const zipPath = path.join(root, 'backup.zip');
    await postJson(source, '/api/sessions/session/export', { destinationPath: zipPath });
    const response = await postJson(source, '/api/sessions/import', { filePath: zipPath });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'destination_conflict' });
    expect(sourceDb.sqlite.prepare('SELECT id, title FROM sessions').all()).toEqual([
      { id: 'session', title: '会话备份' },
    ]);
    expect(onImported).not.toHaveBeenCalled();
  });

  it('文件不存在或不是有效 ZIP 时返回错误, 不产生会话', async () => {
    const zipPath = path.join(root, 'invalid.zip');
    const missing = await postJson(target, '/api/sessions/import', { filePath: zipPath });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'invalid_zip' });
    fs.writeFileSync(zipPath, 'not a zip');
    const invalid = await postJson(target, '/api/sessions/import', { filePath: zipPath });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'invalid_zip' });
    expect(targetDb.sqlite.prepare('SELECT id FROM sessions').all()).toEqual([]);
    expect(onImported).not.toHaveBeenCalled();
  });

  it('导入只传 JSON 路径, 使用普通 JSON 请求体限制', () => {
    expect(resolveRequestBudget('POST', '/api/sessions/import')?.id).toBe('default-json');
  });
});
