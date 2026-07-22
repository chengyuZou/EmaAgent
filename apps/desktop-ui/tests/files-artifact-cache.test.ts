// 测试文件浏览器作用域隔离，以及 Artifact 缓存的代次、失效和并发响应保护。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asSessionId,
} from '@ema-agent/ids';
import { asArtifactId, type Artifact } from '@ema-agent/artifact';
import { artifactsApi } from '../src/api/artifacts.js';
import {
  DirectoryRequestGate,
  workspaceBrowserScopeKey,
} from '../src/chat/workspace-browser-cache.js';
import { useArtifactStore } from '../src/stores/artifact-store.js';

function artifact(sessionId: string, id: string): Artifact {
  return {
    id: asArtifactId(id),
    sessionId: asSessionId(sessionId),
    type: 'text/plain',
    title: id,
    meta: {},
    contentLocation: 'inline',
    content: id,
    createdAt: 1,
    updatedAt: 1,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useArtifactStore.setState({
    bySession: new Map(),
    loadStateBySession: new Map(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('工作区文件浏览器缓存', () => {
  it('同一路径在不同 Session 下仍使用不同作用域', () => {
    expect(workspaceBrowserScopeKey('session-a', 'D:\\workspace'))
      .not.toBe(workspaceBrowserScopeKey('session-b', 'D:\\workspace'));
    expect(workspaceBrowserScopeKey('session-a', 'D:\\workspace'))
      .not.toBe(workspaceBrowserScopeKey('session-a', 'D:\\other'));
  });

  it('同路径的新请求和组件销毁都会使旧响应失效', () => {
    const gate = new DirectoryRequestGate();
    const oldRequest = gate.begin('D:\\workspace');
    const currentRequest = gate.begin('D:\\workspace');

    expect(gate.isCurrent(oldRequest)).toBe(false);
    expect(gate.isCurrent(currentRequest)).toBe(true);

    gate.dispose();
    expect(gate.isCurrent(currentRequest)).toBe(false);
  });
});

describe('Artifact generation 缓存', () => {
  it('SSE 先写入的缓存不会阻止随后拉取权威列表', async () => {
    const sessionId = asSessionId('session-a');
    const fromEvent = artifact('session-a', 'event-artifact');
    const fromServer = artifact('session-a', 'server-artifact');
    const list = vi.spyOn(artifactsApi, 'list').mockResolvedValue({ artifacts: [fromServer] });

    useArtifactStore.getState().upsertFromEvent(fromEvent);
    expect(useArtifactStore.getState().loadStateBySession.get('session-a')?.status).toBe('stale');

    await useArtifactStore.getState().loadForSession(sessionId);

    expect(list).toHaveBeenCalledOnce();
    expect(useArtifactStore.getState().bySession.get('session-a')).toEqual([fromServer]);
    expect(useArtifactStore.getState().loadStateBySession.get('session-a')?.status).toBe('ready');
  });

  it('旧 HTTP 响应不能覆盖请求期间到达的 SSE Artifact', async () => {
    const sessionId = asSessionId('session-a');
    const pending = deferred<{ artifacts: Artifact[] }>();
    vi.spyOn(artifactsApi, 'list').mockReturnValueOnce(pending.promise);

    const oldLoad = useArtifactStore.getState().loadForSession(sessionId);
    const fromEvent = artifact('session-a', 'event-artifact');
    useArtifactStore.getState().upsertFromEvent(fromEvent);
    pending.resolve({ artifacts: [] });
    await oldLoad;

    expect(useArtifactStore.getState().bySession.get('session-a')).toEqual([fromEvent]);
    expect(useArtifactStore.getState().loadStateBySession.get('session-a'))
      .toMatchObject({ status: 'stale', generation: 1 });
  });

  it('显式失效会提升代次，并允许下一次重新加载', async () => {
    const sessionId = asSessionId('session-a');
    const first = artifact('session-a', 'first');
    const second = artifact('session-a', 'second');
    const list = vi.spyOn(artifactsApi, 'list')
      .mockResolvedValueOnce({ artifacts: [first] })
      .mockResolvedValueOnce({ artifacts: [second] });

    await useArtifactStore.getState().loadForSession(sessionId);
    useArtifactStore.getState().invalidateSession(sessionId);
    await useArtifactStore.getState().loadForSession(sessionId);

    expect(list).toHaveBeenCalledTimes(2);
    expect(useArtifactStore.getState().bySession.get('session-a')).toEqual([second]);
    expect(useArtifactStore.getState().loadStateBySession.get('session-a'))
      .toMatchObject({ status: 'ready', generation: 1 });
  });

  it('Session 被逐出后，尚未完成的响应不能重新写回缓存', async () => {
    const sessionId = asSessionId('session-a');
    const pending = deferred<{ artifacts: Artifact[] }>();
    vi.spyOn(artifactsApi, 'list').mockReturnValueOnce(pending.promise);

    const load = useArtifactStore.getState().loadForSession(sessionId);
    useArtifactStore.getState().evictSession(sessionId);
    pending.resolve({ artifacts: [artifact('session-a', 'late')] });
    await load;

    expect(useArtifactStore.getState().bySession.has('session-a')).toBe(false);
    expect(useArtifactStore.getState().loadStateBySession.has('session-a')).toBe(false);
  });
});
