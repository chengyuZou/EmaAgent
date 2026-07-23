// 测试 Session 的 Turn 索引与锚点消息窗口 HTTP 契约。
import { describe, expect, it, vi } from 'vitest';
import type { AppBindings } from '../src/wiring/index.js';
import { sessionsRoute } from '../src/routes/sessions.js';

function bindings(): AppBindings {
  return {
    session: {
      listTurnIndex: vi.fn(() => ({
        items: [{
          turnId: 'turn-2',
          startedAt: 20,
          completedAt: 30,
          status: 'completed',
          triggerType: 'userMessage',
          executionProfile: 'chat',
          preview: '第二轮',
        }],
        nextCursor: 'cursor-next',
      })),
      listMessageWindow: vi.fn(() => ({
        anchorTurnId: 'turn-2',
        turns: [{
          id: 'turn-2',
          sessionId: 'session-a',
          triggerType: 'userMessage',
          executionProfile: 'chat',
          narrativePolicy: 'off',
          status: 'completed',
          userInput: '第二轮',
          startedAt: 20,
          completedAt: 30,
          errorCode: null,
          errorMessage: null,
          iterations: 1,
          usageInputTokens: 2,
          usageOutputTokens: 3,
        }],
        messages: [{
          id: 'message-2',
          sessionId: 'session-a',
          turnId: 'turn-2',
          role: 'user',
          kind: 'normal',
          blocks: '第二轮',
          interrupted: false,
          createdAt: 20,
        }],
        hasOlder: true,
        hasNewer: false,
      })),
    },
    attachmentStore: {
      listByTurn: vi.fn(() => []),
    },
  } as unknown as AppBindings;
}

describe('Session history routes', () => {
  it('返回轻量 Turn 索引页', async () => {
    const appBindings = bindings();
    const response = await sessionsRoute(appBindings).request(
      '/session-a/turn-index?limit=20',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ turnId: 'turn-2', preview: '第二轮' }],
      nextCursor: 'cursor-next',
    });
    expect(appBindings.session.listTurnIndex).toHaveBeenCalledWith(
      'session-a',
      { limit: 20 },
    );
  });

  it('锚点窗口路由优先于普通 messages 路由', async () => {
    const appBindings = bindings();
    const response = await sessionsRoute(appBindings).request(
      '/session-a/messages/window?anchorTurnId=turn-2&beforeTurns=3&afterTurns=4',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      anchorTurnId: 'turn-2',
      messages: [{ id: 'message-2' }],
      hasOlder: true,
      hasNewer: false,
    });
    expect(appBindings.session.listMessageWindow).toHaveBeenCalledWith(
      'session-a',
      {
        anchorTurnId: 'turn-2',
        beforeTurns: 3,
        afterTurns: 4,
      },
    );
  });

  it('拒绝超过总窗口上限的请求', async () => {
    const response = await sessionsRoute(bindings()).request(
      '/session-a/messages/window?anchorTurnId=turn-2&beforeTurns=25&afterTurns=25',
    );

    expect(response.status).toBe(400);
  });
});
