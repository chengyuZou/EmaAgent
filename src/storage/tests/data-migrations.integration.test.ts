import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../database/database.js';
import { MigrationsRunner } from '../database/migrationsRunner.js';

let database: Database | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  database?.close();
  database = undefined;
});

function withNextMigration(sql: string): void {
  const readDirectory = fs.readdirSync.bind(fs);
  const readFile = fs.readFileSync.bind(fs);
  vi.spyOn(fs, 'readdirSync').mockImplementation((...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]).endsWith(path.join('migrations', 'profile'))) {
      return ['001_initial.sql', '002_test.sql'] as never;
    }
    return readDirectory(...args);
  });
  vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).endsWith('002_test.sql')) {
      return sql;
    }
    return readFile(...args);
  });
}

describe('database initialization', () => {
  it.each(['profile', 'data'] as const)('%s initializes at version 1 and rerunning migrations keeps the schema unchanged', kind => {
    database = new Database({ memory: true, kind });
    expect(database.currentVersion()).toBe(0);
    database.migrate();
    expect(database.currentVersion()).toBe(1);
    const before = database.sqlite.prepare(
      "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name",
    ).all();

    new MigrationsRunner(database.sqlite, kind).run();

    expect(database.currentVersion()).toBe(1);
    expect(database.sqlite.prepare(
      "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name",
    ).all()).toEqual(before);
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(database.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('profile contains provider seeds and stores skill choices without a separate migration table', () => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
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

  it('data starts with current permission, Turn and subagent fields', () => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
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
  ])('initializes %s with its domestic catalog and endpoints', (id, name, iconId, baseUrl) => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();

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

  it('initializes DeepSeek Vision without selecting or enabling a model', () => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();

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

  it.each(['profile', 'data'] as const)('%s refuses a database newer than its SQL files', kind => {
    database = new Database({ memory: true, kind });
    database.sqlite.pragma('user_version = 2');
    expect(() => database!.migrate()).toThrow(/v2.*v1/);
    expect(database.currentVersion()).toBe(2);
    expect(database.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([]);
  });
});

describe('numbered migrations', () => {
  it('applies the next SQL once and keeps existing rows', () => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    database.sqlite.exec("INSERT INTO settings VALUES ('keep', '42', 1)");
    withNextMigration("CREATE TABLE migration_check (value TEXT); INSERT INTO migration_check VALUES ('done');");
    const runner = new MigrationsRunner(database.sqlite, 'profile');

    runner.run();
    runner.run();

    expect(database.currentVersion()).toBe(2);
    expect(database.sqlite.prepare('SELECT * FROM migration_check').all()).toEqual([{ value: 'done' }]);
    expect(database.sqlite.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get('keep')).toBe('42');
  });

  it('rolls back failed SQL and its version update, then restores foreign keys', () => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    withNextMigration(`
      -- ema:migration foreign_keys=off
      CREATE TABLE migration_check (value TEXT);
      INSERT INTO missing_table VALUES (1);
    `);
    expect(() => new MigrationsRunner(database!.sqlite, 'profile').run()).toThrow(/missing_table/);
    expect(database.currentVersion()).toBe(1);
    expect(database.sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = 'migration_check'").get())
      .toBeUndefined();
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
