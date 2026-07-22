// 测试 Chat/Work 与 Narrative 策略按 Session 持久化并在失败时回滚。
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/tts-playback.js', () => ({
  handleTtsChunk: vi.fn(),
  handleTtsSentenceComplete: vi.fn(),
}));

import { asSessionId } from '@ema-agent/contracts';
import type { SessionWire } from '@ema-agent/session';
import { sessionsApi } from '../src/api/sessions.js';
import { useSessionStore } from '../src/stores/session-store.js';

const originalPatch = sessionsApi.patch;

function session(): SessionWire {
  return {
    id: 'session-a',
    title: 'session-a',
    workspaceRoot: null,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    archivedAt: null,
    pinned: false,
    pinnedAt: null,
    groupLabel: null,
    parentSessionId: null,
    runningTurnCount: 0,
    executionProfile: 'chat',
    narrativePolicy: 'auto',
    preferredProviderConfigId: null,
    preferredModelId: null,
    lastViewedAt: null,
    lastTurnStatus: null,
    hasUnread: false,
  };
}

function seed(value: SessionWire): void {
  useSessionStore.setState({
    sessions: {
      pinned: [],
      byGroup: [],
      recent: [value],
      archived: [],
      byId: new Map([[value.id, value]]),
    },
    loading: false,
    error: null,
  });
}

afterEach(() => {
  sessionsApi.patch = originalPatch;
});

describe('Session execution settings', () => {
  it('直接提交新执行契约，不再发送旧 mode', async () => {
    const original = session();
    seed(original);
    const patch = vi.fn(async () => ({
      ...original,
      executionProfile: 'work' as const,
      narrativePolicy: 'always' as const,
    }));
    sessionsApi.patch = patch;

    await useSessionStore.getState().setExecutionSettings(asSessionId(original.id), {
      executionProfile: 'work',
      narrativePolicy: 'always',
    });

    expect(patch).toHaveBeenCalledWith(asSessionId(original.id), {
      executionProfile: 'work',
      narrativePolicy: 'always',
    });
    expect(useSessionStore.getState().sessions.byId.get(original.id)).toMatchObject({
      executionProfile: 'work',
      narrativePolicy: 'always',
    });
  });

  it('保存失败时恢复原来的 Profile 与策略', async () => {
    const original = session();
    seed(original);
    sessionsApi.patch = vi.fn(async () => {
      throw new Error('offline');
    });

    await expect(useSessionStore.getState().setExecutionSettings(asSessionId(original.id), {
      executionProfile: 'work',
      narrativePolicy: 'off',
    })).rejects.toThrow('offline');

    expect(useSessionStore.getState().sessions.byId.get(original.id)).toMatchObject({
      executionProfile: 'chat',
      narrativePolicy: 'auto',
    });
  });
});
