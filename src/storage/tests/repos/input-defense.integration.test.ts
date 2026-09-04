import { describe, expect, it } from 'vitest';
import {
  AgentRunMessageSerializationError,
  AgentRunMessagesRepo,
  AgentRunsRepo,
  CharacterRepo,
  CharacterUpdateContractError,
  Database,
  DocumentAssetRepo,
  DocumentPreviewRepo,
  DocumentPreviewValidationError,
  SettingSerializationError,
  SettingsRepo,
} from '../../index.js';

type TestDatabaseKind = 'profile' | 'data' | 'kb';

function withDatabase<T>(kind: TestDatabaseKind, run: (database: Database) => T): T {
  const database = new Database({ memory: true, kind });
  database.migrate();
  try {
    return run(database);
  } finally {
    database.close();
  }
}

describe('N-003 Settings JSON 防御', () => {
  it('区分有效、缺失和损坏设置，get 对损坏值安全回退', () => {
    withDatabase('profile', (database) => {
      const repo = new SettingsRepo(database.sqlite);
      repo.set('valid', { enabled: true }, 1);
      database.sqlite
        .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
        .run('corrupted', '{invalid-json', 2);

      expect(repo.read('valid')).toEqual({
        status: 'found',
        value: { enabled: true },
      });
      expect(repo.read('missing')).toEqual({ status: 'missing' });
      expect(repo.read('corrupted')).toEqual({
        status: 'corrupted',
        rawValue: '{invalid-json',
      });
      expect(repo.get('corrupted')).toBeUndefined();
      expect(repo.all().find((row) => row.key === 'corrupted')?.value_json)
        .toBe('{invalid-json');
    });
  });

  it('拒绝 undefined 和循环引用且不写入数据库', () => {
    withDatabase('profile', (database) => {
      const repo = new SettingsRepo(database.sqlite);
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      expect(() => repo.set('undefined', undefined))
        .toThrow(SettingSerializationError);
      expect(() => repo.set('circular', circular))
        .toThrow(SettingSerializationError);
      expect(repo.all()).toEqual([]);
    });
  });
});

describe('N-004 Character 更新契约', () => {
  it('拒绝通过普通 update 修改激活状态、内置标记和目录名', () => {
    withDatabase('profile', (database) => {
      const repo = new CharacterRepo(database.sqlite);
      const id = 'character-a';
      repo.insert({
        id,
        name: 'Character A',
        directoryName: 'character-a',
        personaPrompt: '人设',
        isActive: true,
        isBuiltin: true,
        createdAt: 1,
        updatedAt: 1,
      });

      expect(() => repo.update(id, { isActive: false } as never))
        .toThrow(CharacterUpdateContractError);
      expect(() => repo.update(id, { isBuiltin: false } as never))
        .toThrow(CharacterUpdateContractError);
      expect(() => repo.update(id, { directoryName: 'renamed' } as never))
        .toThrow(CharacterUpdateContractError);
      expect(repo.findById(id)).toMatchObject({ is_active: 1, is_builtin: 1 });
    });
  });

  it('普通业务字段仍可更新', () => {
    withDatabase('profile', (database) => {
      const repo = new CharacterRepo(database.sqlite);
      const id = 'character-a';
      repo.insert({
        id,
        name: 'Before',
        directoryName: 'before',
        personaPrompt: '人设',
        createdAt: 1,
        updatedAt: 1,
      });

      repo.update(id, { name: 'After', updatedAt: 2 });

      expect(repo.findById(id)).toMatchObject({ name: 'After', updated_at: 2 });
    });
  });

  it('目录名唯一约束拒绝重复物理名称', () => {
    withDatabase('profile', (database) => {
      const repo = new CharacterRepo(database.sqlite);
      repo.insert({
        id: 'a',
        name: 'A',
        directoryName: 'same',
        personaPrompt: '人设',
        createdAt: 1,
        updatedAt: 1,
      });
      expect(() => repo.insert({
        id: 'b',
        name: 'B',
        directoryName: 'same',
        personaPrompt: '人设',
        createdAt: 2,
        updatedAt: 2,
      })).toThrow();
      expect(repo.findByDirectoryName('same')?.id).toBe('a');
    });
  });
});

describe('N-007 DocumentPreview MIME 契约', () => {
  it('PNG 缩略图可以完整往返', () => {
    withDatabase('kb', (database) => {
      insertAsset(database, 'asset-a');
      const repo = new DocumentPreviewRepo(database.sqlite);
      repo.upsert({
        assetId: 'asset-a',
        text: 'preview',
        thumbnail: new Uint8Array([137, 80, 78, 71]),
        thumbnailMime: 'image/png',
        wordCount: 1,
      });

      expect(repo.findByAsset('asset-a')).toMatchObject({
        assetId: 'asset-a',
        thumbnailMime: 'image/png',
      });
    });
  });

  it('拒绝只提供缩略图或只提供 MIME', () => {
    withDatabase('kb', (database) => {
      insertAsset(database, 'asset-a');
      const repo = new DocumentPreviewRepo(database.sqlite);

      expect(() => repo.upsert({
        assetId: 'asset-a',
        text: '',
        thumbnail: new Uint8Array([1]),
        wordCount: 0,
      })).toThrow(DocumentPreviewValidationError);
      expect(() => repo.upsert({
        assetId: 'asset-a',
        text: '',
        thumbnailMime: 'image/png',
        wordCount: 0,
      })).toThrow(DocumentPreviewValidationError);
    });
  });

  it('读取到伪装成 PNG 类型的数据库坏值时明确失败', () => {
    withDatabase('kb', (database) => {
      insertAsset(database, 'asset-a');
      database.sqlite.prepare(`
        INSERT INTO document_previews
          (asset_id, text, thumbnail, thumbnail_mime, word_count)
        VALUES (?, ?, ?, ?, ?)
      `).run('asset-a', '', Buffer.from([1]), 'image/jpeg', 0);

      const repo = new DocumentPreviewRepo(database.sqlite);
      expect(() => repo.findByAsset('asset-a'))
        .toThrow(DocumentPreviewValidationError);
    });
  });
});

describe('AgentRunMessage 序列化防御', () => {
  it('合法内容正常写入并保持 JSON', () => {
    withDatabase('data', (database) => {
      insertAgentRun(database, 'run-a');
      const repo = new AgentRunMessagesRepo(database.sqlite);
      repo.insert({
        agentRunId: 'run-a',
        role: 'assistant',
        content: { text: 'hello' },
        createdAt: 2,
      });

      expect(repo.listForRun('run-a')).toHaveLength(1);
      expect(JSON.parse(repo.listForRun('run-a')[0]!.content_json))
        .toEqual({ text: 'hello' });
    });
  });

  it('undefined 和循环引用在进入 SQLite 前被明确拒绝', () => {
    withDatabase('data', (database) => {
      insertAgentRun(database, 'run-a');
      const repo = new AgentRunMessagesRepo(database.sqlite);
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      expect(() => repo.insert({
        agentRunId: 'run-a',
        role: 'assistant',
        content: undefined,
        createdAt: 2,
      })).toThrow(AgentRunMessageSerializationError);
      expect(() => repo.insert({
        agentRunId: 'run-a',
        role: 'tool_result',
        content: circular,
        createdAt: 3,
      })).toThrow(AgentRunMessageSerializationError);
      expect(repo.listForRun('run-a')).toEqual([]);
    });
  });
});

function insertAsset(database: Database, id: string): void {
  new DocumentAssetRepo(database.sqlite).insert({
    id,
    sourcePath: `D:/Docs/${id}.txt`,
    filePath: `files/${id}.txt`,
    fileName: `${id}.txt`,
    mimeType: 'text/plain',
    wordCount: 0,
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  });
}

function insertAgentRun(database: Database, id: string): void {
  database.sqlite.prepare(`
    INSERT INTO sessions (id, title, created_at, updated_at)
    VALUES ('session-a', 'Session A', 1, 1)
  `).run();
  database.sqlite.prepare(`
    INSERT INTO turns (
      id, session_id, trigger_type, execution_profile, narrative_policy,
      status, created_at
    ) VALUES ('turn-a', 'session-a', 'userMessage', 'work', 'auto', 'running', 1)
  `).run();
  new AgentRunsRepo(database.sqlite).insert({
    id,
    sessionId: 'session-a',
    parentTurnId: 'turn-a',
    contextMode: 'subagent',
    createdAt: 1,
  });
}
