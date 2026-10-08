// 验证真实 Server reminder 生产方读完身份分页、隔离 Session, 不读取 Run 或子消息.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database, SubagentsRepo, SubagentRunsRepo } from '@ema-agent/storage';
import { SubagentStore } from '@ema-agent/agent';
import type { TurnExecutorDeps, TurnReminderScope } from '../../../src/turn/turn.js';
import { renderTurnReminder } from '../../../src/turn/prepare/turnReminder.js';
import { openTurns, type TurnCompositionDeps } from '../src/composition/turn.js';

const captured = vi.hoisted(() => ({
  readTurnReminder: undefined as TurnExecutorDeps['readTurnReminder'] | undefined,
}));
vi.mock('@ema-agent/turn', () => ({
  SessionInteractionQueue: class {},
  SessionContinuationQueue: class {},
  TurnExecutor: class {
    constructor(deps: TurnExecutorDeps) { captured.readTurnReminder = deps.readTurnReminder; }
  },
}));
vi.mock('@ema-agent/memory', () => ({
  buildMemoryGuidance: async () => '',
  memorySummaryFile: () => '',
  MEMORY_SUMMARY_TOKENS: 100,
  readMemorySummary: async () => '',
  readRelationshipMemoryForTurn: async () => '',
  relationshipMemoryDir: () => '',
  workMemoryDir: () => '',
}));

const databases: Database[] = [];
const roots: string[] = [];
afterEach(() => {
  databases.splice(0).forEach(db => db.close());
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
  captured.readTurnReminder = undefined;
});

describe('Server 子代理 reminder 目录', () => {
  it('超过分页上限仍全部交付, 最近身份在前, 下一次读取反映身份修改', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    databases.push(db);
    db.migrate();
    db.sqlite.prepare(`INSERT INTO sessions (id, title, cwd, created_at, updated_at, last_activity_at)
      VALUES (?, '目录测试', '', 1, 1, 1)`).run('session');
    db.sqlite.prepare(`INSERT INTO sessions (id, title, cwd, created_at, updated_at, last_activity_at)
      VALUES (?, '其他会话', '', 1, 1, 1)`).run('other');
    const repo = new SubagentsRepo(db.sqlite);
    const ids = Array.from({ length: 251 }, (_, index) => `agent-${String(index).padStart(3, '0')}`);
    for (const [index, id] of ids.entries()) {
      repo.insert({ id, sessionId: 'session', title: `标题 ${id}`, description: '文'.repeat(60),
        createdAt: Math.floor(index / 3) + 1 });
    }
    repo.insert({ id: 'other-agent', sessionId: 'other', title: '别的 Session', description: '不应出现', createdAt: 1000 });
    const store = new SubagentStore(db.sqlite, repo, new SubagentRunsRepo(db.sqlite));
    const list = vi.spyOn(store, 'listForSession');
    const listRuns = vi.spyOn(store, 'listRuns');
    const readMessages = vi.fn();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-subagent-reminder-'));
    roots.push(root);
    openTurns({
      database: {
        activeDataDir: root, dataDb: db, subagents: store,
        subagentMessages: { loadHistory: readMessages, listPage: readMessages },
        session: { getSession: () => ({ cwd: '' }) },
        tasks: { shouldRemind: () => false }, goals: { getCurrent: () => null },
      },
      settings: { get: (definition: { defaultValue: unknown }) => definition.defaultValue, subscribe: vi.fn() },
      providers: {}, tools: {}, narrative: {}, characters: {}, stage: {},
      publishSubagent: vi.fn(), publishQueuedInput: vi.fn(), emitAppEvent: vi.fn(),
      publishInteraction: vi.fn(),
      onTurnCompletedInTransaction: vi.fn(), fanout: {},
    } as unknown as TurnCompositionDeps);
    const scope: TurnReminderScope = {
      sessionId: 'session', turnId: 'turn-1', characterName: 'test', sessionMode: 'chat',
      narrativePolicy: 'off', userText: '', signal: new AbortController().signal, emit: vi.fn(),
    };
    const first = await captured.readTurnReminder!(scope);
    expect(first.subagents?.map(subagent => subagent.id)).toEqual([...ids].reverse());
    expect(list).toHaveBeenCalledTimes(6);
    expect(list.mock.calls.every(call => call[0] === 'session')).toBe(true);
    const rendered = renderTurnReminder(first);
    const lines = rendered.split('## 本 Session 子代理目录\n')[1]!.split('\n\n## Goal')[0]!.split('\n');
    expect(lines).toHaveLength(251);
    expect(JSON.parse(lines[9]!)).toMatchObject({ id: 'agent-241', description: '文'.repeat(50) });
    expect(lines[10]).toBe('agent-240');
    expect(lines.at(-1)).toBe('agent-000');
    db.sqlite.prepare("UPDATE subagents SET title = '修改后的标题', description = '修改后的说明', updated_at = 2000 WHERE id = 'agent-000'")
      .run();
    const second = await captured.readTurnReminder!({ ...scope, turnId: 'turn-2' });
    expect(second.subagents?.[0]).toMatchObject({ id: 'agent-000', title: '修改后的标题', description: '修改后的说明' });
    expect(renderTurnReminder(first)).toBe(rendered);
    expect(listRuns).not.toHaveBeenCalled();
    expect(readMessages).not.toHaveBeenCalled();
    expect(repo.findById('agent-250')?.description).toHaveLength(60);
  });
});
