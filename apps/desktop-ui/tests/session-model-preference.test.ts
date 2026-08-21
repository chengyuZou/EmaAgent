// 测试模型偏好按 Session 隔离、失败回滚，并由共享模型目录派生上下文上限。
import { afterEach, describe, expect, it, vi } from 'vitest';

// session-store 间接引用 TTS 播放；该测试只验证 Session 状态，不加载 Pixi/Live2D。
vi.mock('../src/lib/tts-playback.js', () => ({
  handleTtsChunk: vi.fn(), handleTtsSentenceComplete: vi.fn(), }));

import type { SessionWire } from '@ema-agent/session';
import { sessionsApi } from '../src/api/sessions.js';
import { findEnabledModel } from '../src/stores/model-catalog-store.js';
import { useSessionStore } from '../src/stores/session-store.js';

function session(id: string): SessionWire {
  return {
    id,
    title: id,
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

function seedSessions(...items: SessionWire[]): void {
  useSessionStore.setState({
    sessions: {
      pinned: [],
      byGroup: [],
      recent: items,
      archived: [],
      byId: new Map(items.map((item) => [item.id, item])),
    },
    loading: false,
    error: null,
  });
}

const originalPatch = sessionsApi.patch;

afterEach(() => {
  sessionsApi.patch = originalPatch;
  seedSessions();
});

describe('Session model preference', () => {
  it('只更新目标 Session，并把供应商和模型作为一对提交', async () => {
    const sessionA = session('session-a');
    const sessionB = session('session-b');
    seedSessions(sessionA, sessionB);
    const patch = vi.fn(async () => ({
      ...sessionA,
      preferredProviderConfigId: 'provider-1',
      preferredModelId: 'model-1',
    }));
    sessionsApi.patch = patch;

    await useSessionStore.getState().setPreferredModel('session-a', {
      providerConfigId: 'provider-1',
      modelId: 'model-1',
    });

    expect(patch).toHaveBeenCalledWith('session-a', {
      preferredModel: {
        providerConfigId: 'provider-1',
        modelId: 'model-1',
      },
    });
    expect(useSessionStore.getState().sessions.byId.get('session-a')).toMatchObject({
      preferredProviderConfigId: 'provider-1',
      preferredModelId: 'model-1',
    });
    expect(useSessionStore.getState().sessions.byId.get('session-b')).toMatchObject({
      preferredProviderConfigId: null,
      preferredModelId: null,
    });
  });

  it('保存失败时恢复该 Session 原来的选择', async () => {
    const original = {
      ...session('session-a'),
      preferredProviderConfigId: 'provider-old',
      preferredModelId: 'model-old',
    };
    seedSessions(original);
    sessionsApi.patch = vi.fn(async () => {
      throw new Error('offline');
    });

    await expect(useSessionStore.getState().setPreferredModel('session-a', {
      providerConfigId: 'provider-new',
      modelId: 'model-new',
    })).rejects.toThrow('offline');

    expect(useSessionStore.getState().sessions.byId.get('session-a')).toMatchObject({
      preferredProviderConfigId: 'provider-old',
      preferredModelId: 'model-old',
    });
  });

  it('快速连续选择时按点击顺序写库且旧响应不覆盖新模型', async () => {
    const original = session('session-a');
    seedSessions(original);
    let resolveFirst!: (value: SessionWire) => void;
    let resolveSecond!: (value: SessionWire) => void;
    const firstResponse = new Promise<SessionWire>((resolve) => { resolveFirst = resolve; });
    const secondResponse = new Promise<SessionWire>((resolve) => { resolveSecond = resolve; });
    const patch = vi.fn()
      .mockImplementationOnce(() => firstResponse)
      .mockImplementationOnce(() => secondResponse);
    sessionsApi.patch = patch;

    const firstWrite = useSessionStore.getState().setPreferredModel('session-a', {
      providerConfigId: 'provider-a',
      modelId: 'model-a',
    });
    const secondWrite = useSessionStore.getState().setPreferredModel('session-a', {
      providerConfigId: 'provider-b',
      modelId: 'model-b',
    });
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

    resolveFirst({
      ...original,
      preferredProviderConfigId: 'provider-a',
      preferredModelId: 'model-a',
    });
    await firstWrite;
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(useSessionStore.getState().sessions.byId.get('session-a')).toMatchObject({
      preferredProviderConfigId: 'provider-b',
      preferredModelId: 'model-b',
    });

    resolveSecond({
      ...original,
      preferredProviderConfigId: 'provider-b',
      preferredModelId: 'model-b',
    });
    await secondWrite;
    expect(useSessionStore.getState().sessions.byId.get('session-a')).toMatchObject({
      preferredProviderConfigId: 'provider-b',
      preferredModelId: 'model-b',
    });
  });

  it('使用供应商配置和模型共同定位 Context Window', () => {
    const models = [
      {
        providerId: 'provider-a', providerName: 'A', model: 'same-name',
        contextWindow: 128_000, contextSource: 'table', definitionId: 'a', reasoning: false,
      },
      {
        providerId: 'provider-b', providerName: 'B', model: 'same-name',
        contextWindow: 200_000, contextSource: 'table', definitionId: 'b', reasoning: true,
      },
    ];

    expect(findEnabledModel(models, 'provider-b', 'same-name')?.contextWindow).toBe(200_000);
    expect(findEnabledModel(models, 'missing', 'same-name')).toBeUndefined();
  });
});
