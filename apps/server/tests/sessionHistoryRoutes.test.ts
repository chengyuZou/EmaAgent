// 验证 Session 创建与 History 新契约挂在真实 URL 上，不再返回按 Turn 拼装的正文。
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActiveSessionRegistry, SessionStore } from '@ema-agent/session';
import { Database } from '@ema-agent/storage';
import { TurnStore } from '../../../src/turn/turnStore.js';
import { sessionCollectionRoute } from '../src/routes/sessions/collection.js';
import { sessionHistoryRoute } from '../src/routes/sessions/history.js';

let database: Database;
let sessions: SessionStore;
let turns: TurnStore;
let app: Hono;

beforeEach(() => {
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  sessions = new SessionStore({ db: database });
  turns = new TurnStore({ db: database, activeSessions: new ActiveSessionRegistry() });
  app = new Hono()
    .route('/api/sessions', sessionCollectionRoute({ session: sessions }))
    .route('/api/sessions', sessionHistoryRoute({ session: sessions, turns }));
});

afterEach(() => database.close());

describe('Session collection and History routes', () => {
  it('项目新对话在创建响应中已经绑定项目主工作区与执行偏好', async () => {
    const project = sessions.createProject('Demo', 'D:/demo');
    const response = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        executionProfile: 'work',
        narrativePolicy: 'off',
        permissionMode: 'acceptEdits',
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      projectId: project.id,
      workspaceRoot: 'D:/demo',
      executionProfile: 'work',
      narrativePolicy: 'off',
      permissionMode: 'acceptEdits',
    });
  });

  it('Message 页、Message 锚点、Turn 索引和 Turn 收口各走独立 URL', async () => {
    const session = sessions.createSession();
    const started = turns.startTurn({
      sessionId: session.id,
      triggerType: 'userMessage',
      executionProfile: 'chat',
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
    turns.completeTurn(started.turn.id);
    turns.clearRunning(session.id, started.turn.id);

    const page = await app.request(`/api/sessions/${session.id}/messages?limit=1`);
    const pageBody = await page.json() as { messages: Array<{ blocks: unknown }>; olderCursor?: string };
    expect(pageBody.messages.map(message => message.blocks)).toEqual([[{ type: 'text', text: '第二条' }]]);
    expect(pageBody.olderCursor).toBeTypeOf('string');
    expect('turns' in pageBody).toBe(false);

    const around = await app.request(
      `/api/sessions/${session.id}/messages/around?anchorMessageId=${first.id}&before=0&after=1`,
    );
    expect(await around.json()).toMatchObject({
      messages: [{ id: first.id }, { blocks: [{ type: 'text', text: '第二条' }] }],
      hasOlder: false,
      hasNewer: false,
    });

    const index = await app.request(`/api/sessions/${session.id}/turn-index`);
    expect(await index.json()).toMatchObject({
      items: [{ turnId: started.turn.id, anchorMessageId: first.id }],
    });

    const terminal = await app.request(
      `/api/sessions/${session.id}/turns/${started.turn.id}/messages`,
    );
    expect((await terminal.json() as { messages: unknown[] }).messages).toHaveLength(2);
    expect((await app.request(`/api/sessions/${session.id}/messages/window`)).status).toBe(404);
  });
});
