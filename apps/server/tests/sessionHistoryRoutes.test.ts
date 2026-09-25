// 验证 Session 创建与 History 新契约挂在真实 URL 上，不再返回按 Turn 拼装的正文。
import { Hono } from 'hono';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionRunningRegistry, SessionStore } from '@ema-agent/session';
import { Database, UsageRecordsRepo } from '@ema-agent/storage';
import { TurnStore } from '../../../src/turn/turnStore.js';
import { sessionCollectionRoute } from '../src/routes/sessions/collection.js';
import { sessionActionsRoute } from '../src/routes/sessions/actions.js';
import { sessionHistoryRoute } from '../src/routes/sessions/history.js';
import { projectsRoute } from '../src/routes/workspaces/projects.js';
import { estimateLlmInputTokens } from '@ema-agent/token';

let database: Database;
let sessions: SessionStore;
let turns: TurnStore;
let usageRecords: UsageRecordsRepo;
let app: Hono;

const audioArchive = {
  findMergedFor: () => null,
};

beforeEach(() => {
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  sessions = new SessionStore({ db: database });
  turns = new TurnStore({ db: database, sessionRunning: new SessionRunningRegistry() });
  usageRecords = new UsageRecordsRepo(database.sqlite);
  app = new Hono()
    .route('/api/sessions', sessionCollectionRoute({ session: sessions }))
    .route('/api/sessions', sessionHistoryRoute({
      session: sessions,
      turns,
      usageRecords,
      audioArchive,
      providerModels: { get: () => ({ capability: 'llm', contextWindow: 200_000, inputImage: false }) } as never,
    }))
    .route('/api/sessions', sessionActionsRoute({
      session: sessions,
      turns,
      abortSubagentsForTurn: async () => {},
      deleteSession: async (sessionId) => sessions.deleteSession(sessionId),
    }))
    .route('/api/workspaces', projectsRoute({ session: sessions }));
});

afterEach(() => database.close());

describe('Session collection and History routes', () => {
  it('创建与 PATCH 使用顶层模型身份和单个推理强度, 冷估算只读有效历史', async () => {
    const created = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'p', modelId: 'm', reasoningEffort: 'high' }),
    });
    expect(created.status).toBe(201);
    const session = await created.json() as { id: string; reasoningEffort: string };
    expect(session.reasoningEffort).toBe('high');
    const invalid = await app.request(`/api/sessions/${session.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'other' }),
    });
    expect(invalid.status).toBe(400);
    const patched = await app.request(`/api/sessions/${session.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'p2', modelId: 'm2', reasoningEffort: 'off' }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ providerId: 'p2', modelId: 'm2', reasoningEffort: 'off' });
    sessions.appendMessage({ sessionId: session.id, turnId: null, role: 'user', blocks: '你好' });
    const estimate = await app.request(`/api/sessions/${session.id}/context-estimate`);
    expect(estimate.status).toBe(200);
    expect(await estimate.json()).toMatchObject({ contextWindow: 200_000 });
  });

  it('冷估算包含最后一次 Macro 摘要和覆盖游标后的旧尾部, 不包含被覆盖正文', async () => {
    const session = sessions.createSession({ providerId: 'p', modelId: 'm' });
    sessions.appendMessage({ sessionId: session.id, turnId: null, role: 'user', blocks: 'covered-a' });
    const through = sessions.appendMessage({ sessionId: session.id, turnId: null, role: 'user', blocks: 'covered-b' });
    sessions.appendMessage({ sessionId: session.id, turnId: null, role: 'user', blocks: 'tail-before-summary' });
    sessions.appendHistorySummary({
      sessionId: session.id,
      turnId: null,
      summary: 'summary',
      summarizedThroughMessageId: through.id,
    });
    sessions.appendMessage({ sessionId: session.id, turnId: null, role: 'user', blocks: 'tail-after-summary' });

    const response = await app.request(`/api/sessions/${session.id}/context-estimate`);
    expect(response.status).toBe(200);
    const result = await response.json() as { inputTokens: number; contextWindow: number };
    expect(result.inputTokens).toBe(estimateLlmInputTokens([
      { role: 'user', content: 'summary' },
      { role: 'user', content: 'tail-before-summary' },
      { role: 'user', content: 'tail-after-summary' },
    ]).totalTokens);
  });
  it('项目新对话在创建响应中已固定当前主文件夹为 cwd 与执行偏好', async () => {
    const project = sessions.createProject('Demo', ['D:/demo'], 'D:/demo');
    const response = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        sessionMode: 'work',
        narrativePolicy: 'off',
        permissionMode: 'acceptEdits',
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      projectId: project.id,
      cwd: 'D:/demo',
      sessionMode: 'work',
      narrativePolicy: 'off',
      permissionMode: 'acceptEdits',
    });
  });

  it('创建项目会话时可在请求中同时指定项目与执行目录', async () => {
    const project = sessions.createProject('Demo', [os.tmpdir()], os.tmpdir());
    const response = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, cwd: path.dirname(os.tmpdir()) }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      projectId: project.id,
      cwd: path.dirname(os.tmpdir()),
    });
  });

  it('零文件夹项目可建会话，项目成员可显式修改 cwd，文件夹变动不回写', async () => {
    const createProject = await app.request('/api/workspaces/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Empty', folderPaths: [] }),
    });
    expect(createProject.status).toBe(201);
    const project = await createProject.json() as { id: string };

    const createSession = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(createSession.status).toBe(201);
    const session = await createSession.json() as { id: string; cwd: string };
    expect(session.cwd).toBe(path.join(os.homedir(), '.ema-agent', 'workspace'));

    const patch = await app.request(`/api/sessions/${session.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: os.tmpdir() }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json() as { cwd: string }).cwd).toBe(os.tmpdir());

    const addFolder = await app.request(`/api/workspaces/projects/${project.id}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path.join(os.tmpdir(), 'project-folder') }),
    });
    expect(addFolder.status).toBe(200);
    expect(sessions.getSession(session.id).cwd).toBe(os.tmpdir());

    const removeFolder = await app.request(`/api/workspaces/projects/${project.id}/folders`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path.join(os.tmpdir(), 'project-folder') }),
    });
    expect(removeFolder.status).toBe(200);
    expect(sessions.listProjectFolders(project.id)).toEqual([]);
    expect(sessions.getSession(session.id).cwd).toBe(os.tmpdir());
  });

  it('Message 页、Message 锚点、Turn 索引和 Turn 收口各走独立 URL', async () => {
    const session = sessions.createSession();
    const started = turns.startTurn({
      sessionId: session.id,
      triggerType: 'userMessage',
      sessionMode: 'chat',
      narrativePolicy: 'off',
    });
    const first = sessions.appendMessage({
      sessionId: session.id,
      turnId: started.turn.id,
      role: 'user',
      blocks: '第一条',
    });
    sessions.appendMessage({
      sessionId: session.id,
      turnId: started.turn.id,
      role: 'assistant',
      blocks: [{ type: 'text', text: '第二条' }],
    });
    usageRecords.record({
      id: 'llm-call-root',
      sessionId: session.id,
      turnId: started.turn.id,
      providerId: 'provider',
      modelId: 'model',
      capability: 'llm',
      status: 'completed',
      inputTokens: 120,
      outputTokens: 34,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      quantity: null,
      unit: null,
      durationMs: 10,
      errorCode: null,
      createdAt: 1,
    });
    usageRecords.record({
      id: 'llm-call-child-agent',
      sessionId: session.id,
      turnId: started.turn.id,
      providerId: 'provider',
      modelId: 'model',
      capability: 'llm',
      status: 'completed',
      inputTokens: 30,
      outputTokens: 5,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      quantity: null,
      unit: null,
      durationMs: 4,
      errorCode: null,
      createdAt: 2,
    });
    usageRecords.record({
      id: 'compact:turn-compact',
      sessionId: session.id,
      turnId: started.turn.id,
      providerId: 'provider',
      modelId: 'model',
      capability: 'llm',
      status: 'completed',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      quantity: null,
      unit: null,
      durationMs: 3,
      errorCode: null,
      createdAt: 3,
    });
    turns.completeTurn(started.turn.id);
    turns.clearRunning(session.id, started.turn.id);

    const page = await app.request(`/api/sessions/${session.id}/messages?limit=1`);
    const pageBody = await page.json() as {
      messages: Array<{ blocks: unknown }>;
      olderCursor?: string;
      turnStats: Array<{
        turnId: string;
        inputTokens: number;
        outputTokens: number;
        durationMs: number | null;
      }>;
    };
    expect(pageBody.messages.map(message => message.blocks)).toEqual([[{ type: 'text', text: '第二条' }]]);
    expect(pageBody.olderCursor).toBeTypeOf('string');
    expect(pageBody.turnStats).toEqual([{
      turnId: started.turn.id,
      inputTokens: 160,
      outputTokens: 41,
      durationMs: expect.any(Number),
      audioAvailable: false,
    }]);
    expect('turns' in pageBody).toBe(false);

    const around = await app.request(
      `/api/sessions/${session.id}/messages/around?anchorMessageId=${first.id}&before=0&after=0`,
    );
    const aroundBody = await around.json() as {
      messages: Array<{ id: string }>;
      olderCursor?: string;
      newerCursor?: string;
      turnStats: Array<{
        turnId: string;
        inputTokens: number;
        outputTokens: number;
      }>;
    };
    expect(aroundBody).toMatchObject({
      messages: [{ id: first.id }],
      turnStats: [{
        turnId: started.turn.id,
        inputTokens: 160,
        outputTokens: 41,
      }],
    });
    expect(aroundBody.olderCursor).toBeUndefined();
    expect(aroundBody.newerCursor).toBeTypeOf('string');

    const after = await app.request(
      `/api/sessions/${session.id}/messages?after=${encodeURIComponent(aroundBody.newerCursor!)}&limit=1`,
    );
    expect(await after.json()).toMatchObject({
      messages: [{ blocks: [{ type: 'text', text: '第二条' }] }],
    });
    const conflictingDirections = await app.request(
      `/api/sessions/${session.id}/messages?before=${encodeURIComponent(aroundBody.newerCursor!)}&after=${encodeURIComponent(aroundBody.newerCursor!)}`,
    );
    expect(conflictingDirections.status).toBe(400);

    const index = await app.request(`/api/sessions/${session.id}/turn-index`);
    expect(await index.json()).toMatchObject({
      items: [{ turnId: started.turn.id, anchorMessageId: first.id }],
    });

    const terminal = await app.request(
      `/api/sessions/${session.id}/turns/${started.turn.id}/messages`,
    );
    expect(await terminal.json()).toMatchObject({
      messages: expect.any(Array),
      turnStats: [{
        turnId: started.turn.id,
        inputTokens: 160,
        outputTokens: 41,
      }],
    });
    expect((await app.request(`/api/sessions/${session.id}/messages/window`)).status).toBe(404);
  });

  it('异常收口的 Turn 仍从已落库 LLM 调用返回真实 Token', async () => {
    const session = sessions.createSession();
    const started = turns.startTurn({
      sessionId: session.id,
      triggerType: 'userMessage',
      sessionMode: 'work',
      narrativePolicy: 'off',
    });
    sessions.appendMessage({
      sessionId: session.id,
      turnId: started.turn.id,
      role: 'assistant',
      blocks: '已经输出的回答',
    });
    usageRecords.record({
      id: 'usage-1',
      sessionId: session.id,
      turnId: started.turn.id,
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
      capability: 'llm',
      status: 'completed',
      inputTokens: 35_797,
      outputTokens: 349,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      quantity: null,
      unit: null,
      durationMs: 6_887,
      errorCode: null,
      createdAt: Date.now(),
    });
    turns.abortTurn(session.id, started.turn.id);

    const response = await app.request(`/api/sessions/${session.id}/messages`);
    expect(await response.json()).toMatchObject({
      turnStats: [{
        turnId: started.turn.id,
        inputTokens: 35_797,
        outputTokens: 349,
      }],
    });
  });
});
