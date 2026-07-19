// 测试 Session 附件接口的共享 DTO、磁盘状态透传与不存在会话语义。
import { describe, expect, it, vi } from 'vitest';
import type { AppBindings } from '../src/wiring/index.js';
import { sessionsRoute } from '../src/routes/sessions.js';

function bindings(sessionExists = true): AppBindings {
  return {
    session: {
      getSession: vi.fn(() => {
        if (!sessionExists) throw new Error('session_not_found: session-a');
        return { id: 'session-a' };
      }),
    },
    attachmentStore: {
      inspectBySession: vi.fn(async () => [{
        id: 'attachment-a',
        turnId: 'turn-a',
        sessionId: 'session-a',
        name: '资料.pdf',
        mime: 'application/pdf',
        size: 42,
        mtime: 100,
        localPath: 'D:\\资料\\资料.pdf',
        createdAt: 200,
        fileStatus: 'modified',
      }]),
    },
  } as unknown as AppBindings;
}

describe('Session attachments route', () => {
  it('返回 camelCase DTO 和当前文件状态', async () => {
    const app = sessionsRoute(bindings());
    const response = await app.request('/session-a/attachments');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      attachments: [{
        id: 'attachment-a',
        turnId: 'turn-a',
        sessionId: 'session-a',
        name: '资料.pdf',
        mimeType: 'application/pdf',
        size: 42,
        mtime: 100,
        localPath: 'D:\\资料\\资料.pdf',
        createdAt: 200,
        fileStatus: 'modified',
      }],
    });
  });

  it('不存在的 Session 返回 404，而不是伪装成空列表', async () => {
    const app = sessionsRoute(bindings(false));
    const response = await app.request('/missing/attachments');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'session_not_found' });
  });
});
