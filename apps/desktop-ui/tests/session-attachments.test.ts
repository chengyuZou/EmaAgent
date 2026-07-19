// 测试 Session 附件缓存的会话隔离、强制刷新和过期响应保护。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asSessionId, type SessionAttachmentWire } from '@ema-agent/contracts';
import { sessionsApi } from '../src/api/sessions.js';
import { useSessionAttachmentStore } from '../src/stores/session-attachment-store.js';

function attachment(sessionId: string, id: string): SessionAttachmentWire {
  return {
    id,
    turnId: `turn-${id}`,
    sessionId,
    name: `${id}.txt`,
    mimeType: 'text/plain',
    size: 1,
    mtime: 1,
    fileHandle: `ema-file:v1:${id}`,
    createdAt: 1,
    fileStatus: 'available',
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.restoreAllMocks();
  useSessionAttachmentStore.setState({
    bySession: new Map(),
    loadStateBySession: new Map(),
  });
});

describe('Session attachment store', () => {
  it('分别保存不同 Session 的附件', async () => {
    vi.spyOn(sessionsApi, 'listAttachments').mockImplementation(async (sessionId) => ({
      attachments: [attachment(sessionId as string, sessionId as string)],
    }));

    await Promise.all([
      useSessionAttachmentStore.getState().loadForSession(asSessionId('session-a')),
      useSessionAttachmentStore.getState().loadForSession(asSessionId('session-b')),
    ]);

    expect(useSessionAttachmentStore.getState().bySession.get('session-a')?.[0]?.sessionId)
      .toBe('session-a');
    expect(useSessionAttachmentStore.getState().bySession.get('session-b')?.[0]?.sessionId)
      .toBe('session-b');
  });

  it('强制刷新后，旧响应不能覆盖新结果', async () => {
    const oldRequest = deferred<{ attachments: SessionAttachmentWire[] }>();
    const currentRequest = deferred<{ attachments: SessionAttachmentWire[] }>();
    vi.spyOn(sessionsApi, 'listAttachments')
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise);
    const sessionId = asSessionId('session-a');

    const oldLoad = useSessionAttachmentStore.getState().loadForSession(sessionId);
    const currentLoad = useSessionAttachmentStore.getState().loadForSession(sessionId, true);
    currentRequest.resolve({ attachments: [attachment('session-a', 'current')] });
    await currentLoad;
    oldRequest.resolve({ attachments: [attachment('session-a', 'old')] });
    await oldLoad;

    expect(useSessionAttachmentStore.getState().bySession.get('session-a')?.[0]?.id)
      .toBe('current');
  });

  it('逐出 Session 后，未完成响应不能恢复旧缓存', async () => {
    const request = deferred<{ attachments: SessionAttachmentWire[] }>();
    vi.spyOn(sessionsApi, 'listAttachments').mockReturnValueOnce(request.promise);
    const sessionId = asSessionId('session-a');

    const load = useSessionAttachmentStore.getState().loadForSession(sessionId);
    useSessionAttachmentStore.getState().evictSession(sessionId);
    request.resolve({ attachments: [attachment('session-a', 'late')] });
    await load;

    expect(useSessionAttachmentStore.getState().bySession.has('session-a')).toBe(false);
  });
});
