// 测试 LocalHost 的 Session 持久入口、共享会话笔记与 Memory 纯构造边界。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbedRuntime } from '@ema-agent/embed';
import { LanguageModelRuntime } from '@ema-agent/llm';
import { RerankRuntime } from '@ema-agent/rerank';
import {
  Database,
  ModelBindingsRepo,
  ProviderEmbedModelsRepo,
} from '@ema-agent/storage';
import { createMemoryRuntime } from '../src/wiring/createMemoryRuntime.js';
import { createSessionPersistence } from '../src/wiring/createSessionPersistence.js';
import { sessionDirFor } from '../src/storage-locations/index.js';

const databases: Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Session persistence wiring', () => {
  it('共享统计与会话笔记入口，并在永久删除 Session 后清理派生目录', () => {
    const dataDb = openDatabase('data');
    const activeDataDir = temporaryDirectory('ema-session-persistence-');
    const persistence = createSessionPersistence(dataDb, activeDataDir);
    const session = persistence.session.createSession();
    const sessionDirectory = sessionDirFor(activeDataDir, session.id);
    fs.mkdirSync(sessionDirectory, { recursive: true });

    persistence.sessionNotes.upsert({
      sessionId: session.id,
      body: JSON.stringify([{
        at: 1,
        turnId: 'turn-note',
        delta: '需要跨 Turn 保留的事实',
      }]),
      tokensAtLastUpdate: 8,
      updatedAt: 1,
    });

    expect(persistence.sessionNotes.findBySession(session.id)?.body)
      .toContain('需要跨 Turn 保留的事实');
    expect(persistence.sessionStats).toBeDefined();
    expect(persistence.storageStats).toBeDefined();

    persistence.session.deleteSession(session.id);

    expect(fs.existsSync(sessionDirectory)).toBe(false);
  });
});

describe('Memory runtime wiring', () => {
  it('复用 Session 持久层的同一笔记入口，构造阶段不启动向量索引', () => {
    const profileDb = openDatabase('profile');
    const dataDb = openDatabase('data');
    const persistence = createSessionPersistence(
      dataDb,
      temporaryDirectory('ema-memory-runtime-'),
    );
    const session = persistence.session.createSession();
    persistence.sessionNotes.upsert({
      sessionId: session.id,
      body: JSON.stringify([{
        at: 1,
        turnId: 'turn-memory-note',
        delta: 'Memory 与 Session Dashboard 读取同一份笔记',
      }]),
      tokensAtLastUpdate: 12,
      updatedAt: 1,
    });
    const emit = vi.fn();

    const memory = createMemoryRuntime(
      profileDb,
      dataDb,
      persistence.session,
      persistence.sessionNotes,
      new LanguageModelRuntime([]),
      new EmbedRuntime([]),
      new RerankRuntime([]),
      new ModelBindingsRepo(profileDb.sqlite),
      new ProviderEmbedModelsRepo(profileDb.sqlite),
      emit,
    );

    expect(memory.loadSessionNote(session.id))
      .toContain('Memory 与 Session Dashboard 读取同一份笔记');
    expect(memory.indexStats()).toEqual({ nodes: null, items: null });
    expect(emit).not.toHaveBeenCalled();
  });
});

function openDatabase(kind: 'profile' | 'data'): Database {
  const database = new Database({ memory: true, kind });
  database.migrate();
  databases.push(database);
  return database;
}

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
