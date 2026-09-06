// 数据目录路由:删除双档语义(摘注册/白名单全删)、活动库忙碌闸、任意库只读浏览。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveSessionRegistry } from '@ema-agent/session';
import { Database } from '@ema-agent/storage';
import { dataDirsRoute } from '../src/routes/workspaces/dataDirs.js';

const temporary: string[] = [];
let profileDir: string;
let mainDir: string;
let secondDir: string;
let activeDb: Database;
let activeSessions: ActiveSessionRegistry;
let closeDatabases: ReturnType<typeof vi.fn>;
let readonlyDbs: Map<string, Database>;
let app: ReturnType<typeof dataDirsRoute>;

function seedDb(dirPath: string, sessionId: string): void {
  mkdirSync(dirPath, { recursive: true });
  const db = new Database({ path: path.join(dirPath, 'data.db'), kind: 'data' });
  db.migrate();
  db.sqlite.prepare(`
    INSERT INTO sessions (id, title, pinned, last_activity_at, created_at, updated_at)
    VALUES (?, 's', 0, 1, 1, 1)
  `).run(sessionId);
  db.sqlite.prepare(`
    INSERT INTO messages (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at)
    VALUES (?, ?, NULL, 'user', 'normal', '"你好"', 0, 1)
  `).run(`${sessionId}-m1`, sessionId);
  db.sqlite.prepare(`
    INSERT INTO attachment_images (path, session_id, name, byte_size, created_at)
    VALUES ('/a.png', ?, 'a.png', 100, 1)
  `).run(sessionId);
  if (dirPath === mainDir) activeDb = db;
  else db.close();
}

function writeRegistry(): void {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(path.join(profileDir, 'registry.json'), JSON.stringify({
    active: 'main',
    dirs: [
      { name: 'main', path: mainDir, addedAt: 1 },
      { name: 'second', path: secondDir, addedAt: 2 },
    ],
  }));
}

beforeEach(() => {
  profileDir = mkdtempSync(path.join(tmpdir(), 'ema-profile-'));
  mainDir = mkdtempSync(path.join(tmpdir(), 'ema-main-'));
  secondDir = mkdtempSync(path.join(tmpdir(), 'ema-second-'));
  temporary.push(profileDir, mainDir, secondDir);
  process.env['EMA_PROFILE_DIR'] = profileDir;
  writeRegistry();
  seedDb(mainDir, 's-main');
  seedDb(secondDir, 's-second');
  activeSessions = new ActiveSessionRegistry();
  // 测试里 closeDatabases 要真关(Windows 文件锁),生产是 composition 的真关闭。
  closeDatabases = vi.fn(() => activeDb.close());
  readonlyDbs = new Map();
  app = dataDirsRoute({
    activeDataDir: mainDir,
    dataDb: activeDb,
    activeSessions,
    closeDatabases,
    readonlyDbs,
  });
});

afterEach(() => {
  for (const db of readonlyDbs.values()) db.close();
  readonlyDbs.clear();
  try { activeDb.close(); } catch { /* 活动库删除用例里已被 mock 关过 */ }
  delete process.env['EMA_PROFILE_DIR'];
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('DELETE /data-dirs/:name', () => {
  it('活动库有动静 → 409 dir_busy, 什么都不删', async () => {
    activeSessions.register('s-main', 'exec-1', 'turn');
    const response = await app.request('/data-dirs/main', { method: 'DELETE' });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toBe('dir_busy');
    expect(closeDatabases).not.toHaveBeenCalled();
    expect(existsSync(path.join(mainDir, 'data.db'))).toBe(true);
  });

  it('非活动库 wipe: 白名单照删, 外来文件不碰, 不触发 closeDatabases', async () => {
    mkdirSync(path.join(secondDir, 'sessions'), { recursive: true });
    writeFileSync(path.join(secondDir, '我的笔记.txt'), '别动我');

    const response = await app.request('/data-dirs/second?wipe=1', { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      restartRequired: boolean;
      wipe: { leftovers: string[]; dirRemoved: boolean };
    };
    expect(body.restartRequired).toBe(false);
    expect(closeDatabases).not.toHaveBeenCalled();
    expect(existsSync(path.join(secondDir, 'data.db'))).toBe(false);
    expect(existsSync(path.join(secondDir, '我的笔记.txt'))).toBe(true);
    expect(body.wipe.dirRemoved).toBe(false);
    expect(body.wipe.leftovers).toContain('我的笔记.txt');
  });

  it('活动库安静 wipe: 先关库再删, restartRequired=true', async () => {
    const response = await app.request('/data-dirs/main?wipe=1', { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = await response.json() as { active: string; restartRequired: boolean };
    expect(closeDatabases).toHaveBeenCalledTimes(1);
    expect(body.restartRequired).toBe(true);
    expect(body.active).toBe('second');
    expect(existsSync(path.join(mainDir, 'data.db'))).toBe(false);
  });

  it('只剩一个库 → 409 cannot_remove_last', async () => {
    writeFileSync(path.join(profileDir, 'registry.json'), JSON.stringify({
      active: 'main',
      dirs: [{ name: 'main', path: mainDir, addedAt: 1 }],
    }));
    const response = await app.request('/data-dirs/main', { method: 'DELETE' });
    expect(response.status).toBe(409);
  });
});

describe('只读浏览', () => {
  it('非活动库的 stats / sessions / raw messages 都能读', async () => {
    const stats = await app.request('/data-dirs/second/stats');
    expect(stats.status).toBe(200);
    expect((await stats.json() as { messageCount: number }).messageCount).toBe(1);

    const sessions = await app.request('/data-dirs/second/sessions');
    const sessionList = (await sessions.json() as { sessions: Array<{ id: string }> }).sessions;
    expect(sessionList.some(s => s.id === 's-second')).toBe(true);

    const messages = await app.request('/data-dirs/second/sessions/s-second/messages');
    const rows = (await messages.json() as { messages: Array<{ blocks_json: string }> }).messages;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.blocks_json).toBe('"你好"');
  });

  it('未知库 → 404', async () => {
    expect((await app.request('/data-dirs/ghost/stats')).status).toBe(404);
    expect((await app.request('/data-dirs/ghost/sessions')).status).toBe(404);
  });
});
