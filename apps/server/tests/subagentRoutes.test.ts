// 真实 SQLite + HTTP 验证身份/Run 的路径边界与按 Message Cursor 定位, 不伪造存储结果.
import {
  afterEach,
  describe,
  expect,
  it
} from 'vitest';
import { Hono } from 'hono';
import {
  Database,
  SubagentsRepo,
  SubagentRunsRepo,
  SubagentMessagesRepo
} from '@ema-agent/storage';
import { SubagentStore, SubagentMessagesStore } from '@ema-agent/agent';
import { subagentListRoute } from '../src/routes/subagents/list.js';
import { subagentRunsRoute } from '../src/routes/subagents/runs.js';
import { subagentMessagesRoute } from '../src/routes/subagents/messages.js';

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});
function fixture() {
  const db = new Database({
    memory: true,
    kind: 'data'
  });
  databases.push(db);
  db.migrate();
  db.sqlite.prepare("INSERT INTO sessions(id,title,cwd,created_at,updated_at) VALUES('session','测试','',1,1)").run();
  const subagents = new SubagentStore(
    db.sqlite,
    new SubagentsRepo(db.sqlite),
    new SubagentRunsRepo(db.sqlite)
  );
  const repo = new SubagentMessagesRepo(db.sqlite);
  const subagentMessages = new SubagentMessagesStore(repo);
  const deps = {
    subagents,
    subagentMessages
  };
  const app = new Hono().route('/api/subagents', subagentListRoute(deps))
    .route(
      '/api/subagents',
      subagentRunsRoute(deps)
    ).route(
      '/api/subagents',
      subagentMessagesRoute(deps)
    );
  subagents.start({
    subagentId: 'child',
    runId: 'run-1',
    sessionId: 'session',
    toolCallId: 'call-1',
    title: '检查模块',
    description: '边界检查',
    isNew: true,
    contextMode: 'fork'
  });
  subagents.complete(
    'run-1',
    {
      iterations: 1,
      toolCallCount: 2,
      inputTokens: 3,
      outputTokens: 4,
      finalText: '第一次'
    }
  );
  subagents.start({
    subagentId: 'child',
    runId: 'run-2',
    sessionId: 'session',
    toolCallId: 'call-2',
    isNew: false,
    contextMode: 'subagent'
  });
  subagents.start({
    subagentId: 'other',
    runId: 'other-run',
    sessionId: 'session',
    toolCallId: 'call-other',
    title: '另一个',
    description: '另一项任务',
    isNew: true,
    contextMode: 'subagent'
  });
  for (let index = 0; index < 12; index++) {
    repo.insert({
      id: `m-${String(index).padStart(2, '0')}`,
      subagentId: 'child',
      runId: index < 2 ? null : 'run-1',
      role: index % 2 ? 'assistant' : 'user',
      blocksJson: JSON.stringify(`消息 ${index}`),
      createdAt: index
    });
  }
  repo.insert({
    id: 'task-2',
    subagentId: 'child',
    runId: 'run-2',
    role: 'user',
    blocksJson: JSON.stringify('继续'),
    createdAt: 12
  });
  repo.insert({
    id: 'output-2',
    subagentId: 'child',
    runId: 'run-2',
    role: 'assistant',
    blocksJson: JSON.stringify('执行中'),
    createdAt: 13
  });
  return {
    app,
    subagents,
    repo
  };
}

describe(
  '子代理查询 API',
  () => {
    it(
      'Session 查询参数只筛身份列表, 不被当成子代理 ID; 两层 Cursor 独立分页',
      async () => {
        const { app } = fixture();
        const first = await (await app.request('/api/subagents?sessionId=session&limit=1')).json();
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).toBeTruthy();
        expect(await (await app.request('/api/subagents?sessionId=child')).json()).toMatchObject({
          items: []
        });
        expect(await (await app.request('/api/subagents/child?sessionId=wrong')).json()).toMatchObject({
          id: 'child',
          title: '检查模块'
        });
        const runs = await (await app.request('/api/subagents/child/runs?limit=1')).json();
        const cursor = runs.nextCursor;
        const next = await (await app.request(`/api/subagents/child/runs?limit=1&beforeCreatedAt=${cursor.createdAt}&beforeId=${cursor.id}`)).json();
        expect(new Set([...runs.items, ...next.items].map(run => run.id)).size).toBe(2);
        expect(next.nextCursor).toBeNull();
      }
    );
    it(
      '不同子代理不能读取对方 Run',
      async () => {
        const { app } = fixture();
        expect((await app.request('/api/subagents/child/runs/other-run')).status).toBe(404);
        expect((await app.request('/api/subagents/child/runs/run-1')).status).toBe(200);
      }
    );
    it(
      '连续 Message 历史双向补页, 包含 fork 与多个 Run, 不依赖起始任务',
      async () => {
        const { app } = fixture();
        const page = await (await app.request('/api/subagents/child/messages?beforeCreatedAt=5&beforeId=m-05&limit=5')).json();
        expect(page.items.map(message => message.id)).toEqual(['m-00', 'm-01', 'm-02', 'm-03', 'm-04']);
        expect(page.items[0].runId).toBeNull();
        const cursor = page.newerCursor;
        const next = await (await app.request(`/api/subagents/child/messages?afterCreatedAt=${cursor.createdAt}&afterId=${cursor.id}&limit=3`)).json();
        expect(next.items.map(message => message.id)).toEqual(['m-05', 'm-06', 'm-07']);
        const latest = await (await app.request('/api/subagents/child/messages?limit=2')).json();
        expect(latest.items.map(message => message.id)).toEqual(['task-2', 'output-2']);
        expect(latest.newerCursor).toBeNull();
        expect(latest.olderCursor).toEqual({
          createdAt: 12,
          id: 'task-2'
        });
      }
    );
    it(
      '旧记录没有起始 User Message 仍可读, 已有身份空消息返回 200, 未知身份才 404',
      async () => {
        const {
          app,
          repo
        } = fixture();
        const empty = await app.request('/api/subagents/other/messages');
        expect(empty.status).toBe(200);
        expect(await empty.json()).toEqual({
          items: [],
          olderCursor: null,
          newerCursor: null,
        });

        repo.insert({
          id: 'old-output',
          subagentId: 'other',
          runId: 'other-run',
          role: 'assistant',
          blocksJson: JSON.stringify([{
            type: 'text',
            text: '旧输出'
          }]),
          createdAt: 10,
        });
        repo.insert({
          id: 'old-result',
          subagentId: 'other',
          runId: 'other-run',
          role: 'user',
          kind: 'tool_results',
          blocksJson: JSON.stringify([]),
          createdAt: 11,
        });
        const result = await app.request('/api/subagents/other/messages');
        expect(result.status).toBe(200);
        expect((await result.json()).items.map(message => message.id))
          .toEqual(['old-output', 'old-result']);
        expect((await app.request('/api/subagents/unknown/messages')).status).toBe(404);
      }
    );
    it(
      '时间相同按 ID 继续游标, 畸形/双向参数拒绝',
      async () => {
        const {
          app,
          repo
        } = fixture();
        for (const id of ['same-a', 'same-b', 'same-c']) {
          repo.insert({
            id,
            subagentId: 'child',
            runId: 'run-2',
            role: 'user',
            blocksJson: JSON.stringify(id),
            createdAt: 20
          });
        }
        const latest = await (await app.request('/api/subagents/child/messages?limit=2')).json();
        expect(latest.items.map(message => message.id)).toEqual(['same-b', 'same-c']);
        const previous = await (await app.request('/api/subagents/child/messages?beforeCreatedAt=20&beforeId=same-b&limit=2')).json();
        expect(previous.items.map(message => message.id)).toEqual(['output-2', 'same-a']);
        expect((await app.request('/api/subagents/child/messages?beforeId=m-02')).status).toBe(400);
        expect((await app.request('/api/subagents/child/messages?beforeCreatedAt=2&beforeId=m-02&afterCreatedAt=3&afterId=m-03')).status).toBe(400);
        expect((await app.request('/api/subagents?sessionId=session&beforeId=child')).status).toBe(400);
      }
    );
  }
);
