import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../database/database.js';

let database: Database | undefined;
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  database?.close();
  database = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir())) throw new Error('Unexpected temporary directory');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function withNextMigrations(sql: readonly string[], kind: 'profile' | 'data' = 'profile'): void {
  const readDirectory = fs.readdirSync.bind(fs);
  const readFile = fs.readFileSync.bind(fs);
  vi.spyOn(fs, 'readdirSync').mockImplementation((...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]).endsWith(path.join('migrations', kind))) {
      return ['001_initial.sql', ...sql.map((_, index) => `${String(index + 2).padStart(3, '0')}_test.sql`)] as never;
    }
    return readDirectory(...args);
  });
  vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    const match = /[\\/](\d{3})_test\.sql$/u.exec(String(args[0]));
    if (match) {
      return sql[Number(match[1]) - 2]!;
    }
    return readFile(...args);
  });
}

async function fileDatabase(kind: 'profile' | 'data'): Promise<{ filename: string; copies: string }> {
  const root = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'ema-pre-migration-'));
  temporaryDirectories.push(root);
  const filename = path.join(root, `${kind}.db`);
  database = new Database({ path: filename, kind });
  await database.migrate();
  database.close();
  database = new Database({ path: filename, kind });
  return { filename, copies: path.join(root, 'pre-migration') };
}

describe('database initialization', () => {
  it.each(['profile', 'data'] as const)('%s initializes at version 1 and rerunning migrations keeps the schema unchanged', async kind => {
    database = new Database({ memory: true, kind });
    expect(database.currentVersion()).toBe(0);
    await database.migrate();
    expect(database.currentVersion()).toBe(1);
    const before = database.sqlite.prepare(
      "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name",
    ).all();

    await database.migrate();

    expect(database.currentVersion()).toBe(1);
    expect(database.sqlite.prepare(
      "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name",
    ).all()).toEqual(before);
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(database.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('profile contains provider seeds and stores skill choices without a separate migration table', async () => {
    database = new Database({ memory: true, kind: 'profile' });
    await database.migrate();
    expect(database.sqlite.prepare('SELECT COUNT(*) FROM providers').pluck().get()).toBe(19);
    expect(database.sqlite.prepare('SELECT COUNT(*) FROM provider_capabilities').pluck().get())
      .toBeGreaterThan(19);
    database.sqlite.exec(`
      INSERT INTO skills (path, name, dir_path, installed_at, scope, enabled)
        VALUES ('/skills/check/SKILL.md', 'check', '/skills/check', 1, 'builtin', 0);
    `);
    expect(database.sqlite.prepare('SELECT scope, enabled FROM skills').get())
      .toEqual({ scope: 'builtin', enabled: 0 });
    expect(database.sqlite.prepare(
      "SELECT name FROM sqlite_schema WHERE name LIKE 'skill_enablement%'",
    ).all()).toEqual([]);
    const bindingSql = database.sqlite.prepare(
      "SELECT sql FROM sqlite_schema WHERE name = 'model_bindings'",
    ).pluck().get() as string;
    expect(bindingSql).toContain("'narrative-rerank'");
    expect(bindingSql).not.toContain('lightrag');
  });

  it('data starts with current permission, Turn and subagent fields', async () => {
    database = new Database({ memory: true, kind: 'data' });
    await database.migrate();
    const columns = (table: string) => (
      database!.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>
    ).map(column => column.name);
    expect(columns('turns')).toContain('character_name');
    expect(columns('turns')).toContain('tts_enabled');
    expect(columns('messages')).toContain('summary_saved_tokens');
    expect(columns('subagent_messages')).toContain('run_id');
    expect(columns('subagent_messages')).not.toContain('sequence');
    for (const table of ['sessions', 'turns']) {
      expect(columns(table)).not.toContain('session_mode');
      expect(columns(table)).not.toContain('narrative_policy');
    }
    expect(columns('turns')).not.toContain('usage_input_tokens');
    expect(columns('turns')).not.toContain('usage_output_tokens');
    expect(columns('subagents')).not.toContain('parent_turn_id');
    database.sqlite.exec(`
      INSERT INTO sessions (id, title, cwd, permission_mode, created_at, updated_at)
        VALUES ('session', 'Session', '/work', 'plan', 1, 1);
      INSERT INTO goals (id, session_id, objective, feedback, status, version, created_at, updated_at)
        VALUES ('goal', 'session', 'Finish work', 'First part done', 'active', 1, 1, 1);
    `);
    expect(() => database!.sqlite.prepare(
      'UPDATE sessions SET permission_mode = ?',
    ).run('invalid')).toThrow(/CHECK constraint failed/);
    expect(database.sqlite.prepare('SELECT feedback FROM goals').pluck().get()).toBe('First part done');
  });

  it.each([
    ['siliconflow-cn', 'SiliconFlow-CN', 'siliconflow', 'https://api.siliconflow.cn/v1'],
    ['moonshotai-cn', 'Moonshot Kimi-CN', 'moonshot', 'https://api.moonshot.cn/v1'],
  ])('initializes %s with its domestic catalog and endpoints', async (id, name, iconId, baseUrl) => {
    database = new Database({ memory: true, kind: 'profile' });
    await database.migrate();

    expect(database.sqlite.prepare('SELECT name, icon_id FROM providers WHERE id = ?').get(id))
      .toEqual({ name, icon_id: iconId });
    expect(database.sqlite.prepare('SELECT id FROM providers WHERE id = ?').get(iconId)).toBeUndefined();
    expect(database.sqlite.prepare(`
      SELECT capability, models_dev_id FROM provider_capabilities
      WHERE provider_id = ? AND capability IN ('llm', 'vision') ORDER BY capability
    `).all(id)).toEqual([
      { capability: 'llm', models_dev_id: id },
      { capability: 'vision', models_dev_id: id },
    ]);
    expect(database.sqlite.prepare(
      'SELECT DISTINCT base_url FROM provider_protocols WHERE provider_id = ?',
    ).all(id)).toEqual([{ base_url: baseUrl }]);
  });

  it('initializes DeepSeek Vision without selecting or enabling a model', async () => {
    database = new Database({ memory: true, kind: 'profile' });
    await database.migrate();

    expect(database.sqlite.prepare(`
      SELECT active_protocol, models_dev_id FROM provider_capabilities
      WHERE provider_id = 'deepseek' AND capability = 'vision'
    `).get()).toEqual({ active_protocol: 'openai-llm', models_dev_id: 'deepseek' });
    expect(database.sqlite.prepare(`
      SELECT protocol, base_url FROM provider_protocols
      WHERE provider_id = 'deepseek' AND capability = 'vision' ORDER BY protocol
    `).all()).toEqual([
      { protocol: 'anthropic-llm', base_url: 'https://api.deepseek.com/anthropic' },
      { protocol: 'openai-llm', base_url: 'https://api.deepseek.com' },
    ]);
    expect(database.sqlite.prepare('SELECT * FROM provider_models').all()).toEqual([]);
    expect(database.sqlite.prepare('SELECT * FROM model_bindings').all()).toEqual([]);
  });

  it.each(['profile', 'data'] as const)('%s refuses a database newer than its SQL files', async kind => {
    database = new Database({ memory: true, kind });
    database.sqlite.pragma('user_version = 2');
    await expect(database!.migrate()).rejects.toThrow(/v2.*v1/);
    expect(database.currentVersion()).toBe(2);
    expect(database.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([]);
  });
});

describe('numbered migrations', () => {
  it('applies the next SQL once and keeps existing rows', async () => {
    database = new Database({ memory: true, kind: 'profile' });
    await database.migrate();
    database.sqlite.exec("INSERT INTO settings VALUES ('keep', '42', 1)");
    withNextMigrations(["CREATE TABLE migration_check (value TEXT); INSERT INTO migration_check VALUES ('done');"]);
    await database.migrate();
    await database.migrate();

    expect(database.currentVersion()).toBe(2);
    expect(database.sqlite.prepare('SELECT * FROM migration_check').all()).toEqual([{ value: 'done' }]);
    expect(database.sqlite.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get('keep')).toBe('42');
  });

  it('rolls back failed SQL and its version update, then restores foreign keys', async () => {
    database = new Database({ memory: true, kind: 'profile' });
    await database.migrate();
    withNextMigrations([`
      -- ema:migration foreign_keys=off
      CREATE TABLE migration_check (value TEXT);
      INSERT INTO missing_table VALUES (1);
    `]);
    await expect(database!.migrate()).rejects.toThrow(/missing_table/);
    expect(database.currentVersion()).toBe(1);
    expect(database.sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = 'migration_check'").get())
      .toBeUndefined();
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('pre-migration backups', () => {
  it('backs up committed WAL rows and matching FTS rowids once before a multi-file upgrade', async () => {
    const { filename, copies } = await fileDatabase('data');
    database!.sqlite.pragma('wal_autocheckpoint = 0');
    database!.sqlite.exec(`
      INSERT INTO sessions(id, title, cwd, permission_mode, created_at, updated_at)
        VALUES ('session', 'Session', '/work', 'default', 1, 1);
    `);
    const insert = database!.sqlite.prepare(
      'INSERT INTO messages(id, session_id, role, blocks_json, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const id of ['first', 'removed', 'last']) {
      insert.run(id, 'session', 'assistant', JSON.stringify([{ type: 'text', text: `message ${id}` }]), 1);
    }
    database!.sqlite.prepare('DELETE FROM messages WHERE id = ?').run('removed');
    const rows = database!.sqlite.prepare('SELECT rowid, message_id FROM message_search_documents ORDER BY rowid').all();
    expect(rows).toEqual([{ rowid: 1, message_id: 'first' }, { rowid: 3, message_id: 'last' }]);
    expect(fs.statSync(`${filename}-wal`).size).toBeGreaterThan(32);
    const backup = vi.spyOn(database!.sqlite, 'backup');
    withNextMigrations([
      'CREATE TABLE migration_check(value TEXT)',
      "INSERT INTO migration_check VALUES ('done')",
    ], 'data');

    await database!.migrate();

    expect(backup).toHaveBeenCalledTimes(1);
    expect(database!.currentVersion()).toBe(3);
    const files = fs.readdirSync(copies);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^data\.v1-to-v3\.\d{8}T\d{9}Z\.[a-f0-9-]{36}\.db$/u);
    const copy = new BetterSqlite3(path.join(copies, files[0]!), { readonly: true });
    try {
      expect(copy.pragma('user_version', { simple: true })).toBe(1);
      expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(copy.prepare("SELECT name FROM sqlite_schema WHERE name = 'migration_check'").get()).toBeUndefined();
      expect(copy.prepare('SELECT rowid, message_id FROM message_search_documents ORDER BY rowid').all()).toEqual(rows);
      expect(copy.prepare('SELECT rowid, message_id FROM message_search_fts ORDER BY rowid').all()).toEqual(rows);
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      copy.close();
    }
    expect(database!.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    database!.close();
    database = new Database({ path: filename, kind: 'data' });
    await database.migrate(copies);
    expect(fs.readdirSync(copies)).toEqual(files);
  });

  it('does not create copies for initialization, current versions, newer versions or memory databases', async () => {
    const { filename, copies } = await fileDatabase('profile');
    database!.close();
    fs.unlinkSync(filename);
    database = new Database({ path: filename, kind: 'profile' });
    await database.migrate(copies);
    expect(database.currentVersion()).toBe(1);
    expect(fs.existsSync(copies)).toBe(false);

    database.close();
    database = new Database({ path: filename, kind: 'profile' });
    await database.migrate(copies);
    expect(fs.existsSync(copies)).toBe(false);

    database.close();
    database = new Database({ path: filename, kind: 'profile' });
    database.sqlite.pragma('user_version = 2');
    await expect(database.migrate(copies)).rejects.toThrow(/v2.*v1/u);
    expect(fs.existsSync(copies)).toBe(false);

    database.close();
    database = new Database({ memory: true, kind: 'profile' });
    await database.migrate();
    withNextMigrations(['CREATE TABLE migration_check(value TEXT)']);
    await database.migrate(copies);
    expect(database.currentVersion()).toBe(2);
    expect(fs.existsSync(copies)).toBe(false);
  });

  it.each(['directory', 'copy'] as const)('does not migrate after a %s failure and removes its incomplete copy', async failure => {
    const { copies } = await fileDatabase('profile');
    if (failure === 'directory') {
      fs.writeFileSync(copies, 'not a directory');
    } else {
      vi.spyOn(database!.sqlite, 'backup').mockRejectedValue(new Error('simulated disk full'));
    }
    withNextMigrations(['CREATE TABLE migration_check(value TEXT)']);

    await expect(database!.migrate(copies)).rejects.toThrow(/迁移前副本生成失败/u);

    expect(database!.currentVersion()).toBe(1);
    expect(database!.sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = 'migration_check'").get()).toBeUndefined();
    if (failure === 'copy') expect(fs.readdirSync(copies)).toEqual([]);
  });

  it('keeps previous copies after failed SQL and prunes only its own copies after all SQL succeeds', async () => {
    const { copies } = await fileDatabase('profile');
    fs.mkdirSync(copies);
    const oldCopies: string[] = [];
    for (let index = 1; index <= 4; index++) {
      const name = `profile.v90-to-v91.20200101T00000000${index}Z.00000000-0000-4000-8000-00000000000${index}.db`;
      oldCopies.push(name);
      fs.writeFileSync(path.join(copies, name), 'previous copy');
    }
    const otherDatabase = 'data.v1-to-v2.20200101T000000000Z.00000000-0000-4000-8000-000000000000.db';
    const temporary = `${oldCopies[0]}.tmp`;
    for (const name of [otherDatabase, temporary, 'profile.manual.db']) {
      fs.writeFileSync(path.join(copies, name), 'keep until a successful upgrade');
    }
    const before = fs.readdirSync(copies);
    const sql = ['CREATE TABLE migration_check(value TEXT)', 'INSERT INTO missing_table VALUES (1)'];
    withNextMigrations(sql);

    await expect(database!.migrate(copies)).rejects.toThrow(/missing_table/u);

    expect(database!.currentVersion()).toBe(2);
    expect(fs.readdirSync(copies)).toEqual(expect.arrayContaining(before));
    expect(fs.readdirSync(copies)).toHaveLength(before.length + 1);

    sql[1] = "INSERT INTO migration_check VALUES ('done')";
    await database!.migrate(copies);

    const remaining = fs.readdirSync(copies);
    const profileCopies = remaining.filter(name => /^profile\.v\d+-to-v\d+\..*\.db$/u.test(name));
    expect(profileCopies).toHaveLength(3);
    expect(profileCopies).toEqual(expect.arrayContaining([oldCopies[3]]));
    expect(profileCopies.some(name => name.startsWith('profile.v1-to-v3.'))).toBe(true);
    expect(profileCopies.some(name => name.startsWith('profile.v2-to-v3.'))).toBe(true);
    expect(remaining).toEqual(expect.arrayContaining([otherDatabase, 'profile.manual.db']));
    expect(remaining).not.toContain(temporary);
    expect(database!.currentVersion()).toBe(3);
    expect(database!.sqlite.prepare('SELECT value FROM migration_check').pluck().get()).toBe('done');
  });
});
