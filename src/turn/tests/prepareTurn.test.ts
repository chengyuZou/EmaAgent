// 测试 prepareTurn 的模型解析顺序、附件降级、Skill 冻结与 Profile 分流。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRunMessagesStore, AgentRunStore } from '@ema-agent/agent';
import type { AttachmentStore, Attachment } from '@ema-agent/attachments';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import type { SessionStore } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import type { SkillDescriptor } from '@ema-agent/skills';
import { ToolRegistry } from '@ema-agent/tools';
import type { Turn } from '@ema-agent/turn-terms';
import { SessionInteractionQueue } from '../interactionQueue.js';
import { TurnPreparationError } from '../errors.js';
import {
  prepareTurn,
  type PrepareTurnDeps,
} from '../preparation/prepareTurn.js';
import type { StartTurn } from '../types.js';

const TURN: Turn = {
  id: 't1',
  sessionId: 's1',
  status: 'running',
  triggerType: 'userMessage',
  executionProfile: 'work',
  narrativePolicy: 'off',
  providerId: null,
  modelId: null,
  iterations: 0,
  usageInputTokens: 0,
  usageOutputTokens: 0,
  createdAt: 1,
  completedAt: null,
  errorCode: null,
  errorMessage: null,
};

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    workspaceRoot: '/w',
    projectId: 'p1',
    providerId: 'sess-p',
    modelId: 'sess-m',
    executionProfile: 'work',
    narrativePolicy: 'off',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PrepareTurnDeps> = {}): PrepareTurnDeps {
  const settingsValues = new Map<string, unknown>();
  return {
    sessions: {
      getSession: () => fakeSession(),
    } as unknown as Pick<SessionStore, 'getSession'>,
    providers: {
      resolveConnection: () => ({ protocol: 'openai-chat', baseUrl: 'http://localhost', apiKey: 'k' }),
    } as unknown as Providers,
    providerModels: {
      get: () => ({
        providerId: 'sess-p',
        capability: 'llm',
        modelId: 'sess-m',
        contextWindow: 200_000,
        maxOutput: null,
        toolCall: true,
        reasoning: null,
        temperature: null,
        inputImage: true,
      }),
    } as unknown as ProviderModels,
    attachments: {
      addAll: async (inputs: Array<{ sourcePath: string; name?: string }>) =>
        inputs.map((input, index) => ({
          id: `att-${index}`,
          kind: 'file',
          name: input.name ?? 'f.txt',
          mimeType: 'text/plain',
          sourcePath: input.sourcePath,
        })),
    } as unknown as AttachmentStore,
    settings: {
      get: (def: { key: string; defaultValue: unknown }) =>
        settingsValues.has(def.key) ? settingsValues.get(def.key) : def.defaultValue,
      set: (def: { key: string }, value: unknown) => { settingsValues.set(def.key, value); },
    } as unknown as SettingsStore,
    characterPrompt: () => ({ prompt: '你是角色', presentation: '' }),
    skillEntries: () => [],
    registry: new ToolRegistry(),
    decisionQueue: new SessionInteractionQueue(null),
    agentRunStore: {} as unknown as AgentRunStore,
    agentRunMessagesStore: {} as unknown as AgentRunMessagesStore,
    ...overrides,
  };
}

function makeStart(overrides: Partial<StartTurn> = {}): StartTurn {
  return {
    sessionId: 's1',
    triggerType: 'userMessage',
    executionProfile: 'work',
    narrativePolicy: 'off',
    userInput: '你好',
    ...overrides,
  };
}

function makeRuntime(start: StartTurn) {
  return {
    start,
    turn: TURN,
    budget: {
      assertWithinLimits: () => undefined,
      remainingOutputTokens: () => 1_000,
      recordUsage: () => undefined,
      reserveToolCall: () => undefined,
      enterSubagent: () => () => undefined,
    },
    prepareSubagent: async () => { throw new Error('不应派生子 Agent'); },
    parentMessages: [],
    emit: () => undefined,
    signal: new AbortController().signal,
  };
}

describe('prepareTurn', () => {
  it('请求与 Session 都未指定模型时准备失败（provider/not_configured）', async () => {
    const deps = makeDeps({
      sessions: { getSession: () => fakeSession({ providerId: null, modelId: null }) } as never,
    });
    await expect(prepareTurn(deps, makeRuntime(makeStart()))).rejects.toThrow(TurnPreparationError);
  });

  it('请求覆盖优先于 Session 偏好，模型未启用时报错', async () => {
    const seen: string[] = [];
    const deps = makeDeps({
      providers: {
        resolveConnection: (providerId: string) => {
          seen.push(providerId);
          return { protocol: 'openai-chat', baseUrl: 'http://localhost' };
        },
      } as unknown as Providers,
      providerModels: {
        get: (providerId: string, capability: string, modelId: string) =>
          providerId === 'req-p' && modelId === 'req-m'
            ? { capability: 'llm', contextWindow: 128_000, inputImage: false }
            : undefined,
      } as unknown as ProviderModels,
    });

    const prepared = await prepareTurn(deps, makeRuntime(makeStart({ providerId: 'req-p', modelId: 'req-m' })));
    expect(prepared.providerId).toBe('req-p');
    expect(prepared.contextWindow).toBe(128_000);
    expect(prepared.supportsImageInput).toBe(false);
    expect(seen).toEqual(['req-p']);

    await expect(prepareTurn(deps, makeRuntime(makeStart()))).rejects.toThrow(/未在该 Provider 下启用/);
  });

  it('chat Profile 不建 SkillPool，work Profile 冻结 Pool 且 deny 生效', async () => {
    const descriptor: SkillDescriptor = {
      key: 'user:demo' as SkillDescriptor['key'],
      name: 'demo',
      callName: 'demo',
      version: '1.0.0',
      description: 'd',
      allowedToolPatterns: [],
      rootPath: '/skills/demo',
      scope: 'user',
    };
    const deps = makeDeps({ skillEntries: () => [descriptor] });

    const chat = await prepareTurn(deps, makeRuntime(makeStart({ executionProfile: 'chat' })));
    expect(chat.skillPool).toBeUndefined();

    const work = await prepareTurn(deps, makeRuntime(makeStart()));
    expect(work.skillPool?.getByKey('user:demo' as never)).toBeDefined();
    expect(work.skillPool?.revision).toBeTruthy();
  });

  it('选择不存在或被禁用的 Skill 直接准备失败；合法的冻结正文', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-skill-'));
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Demo 正文');
    const descriptor: SkillDescriptor = {
      key: 'user:demo' as SkillDescriptor['key'],
      name: 'demo',
      callName: 'demo',
      version: '1.0.0',
      description: 'd',
      allowedToolPatterns: [],
      rootPath: dir,
      scope: 'user',
    };
    const deps = makeDeps({ skillEntries: () => [descriptor] });

    await expect(prepareTurn(deps, makeRuntime(makeStart({ selectedSkillKeys: ['user:ghost'] }))))
      .rejects.toThrow(/不存在或已被禁用/);

    const prepared = await prepareTurn(deps, makeRuntime(makeStart({ selectedSkillKeys: ['user:demo'] })));
    expect(prepared.selectedSkills).toEqual([
      { key: 'user:demo', callName: 'demo', content: '# Demo 正文' },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('附件登记失败映射为 turn/attachment_failed', async () => {
    const deps = makeDeps({
      attachments: {
        addAll: async () => { throw new Error('超过单文件上限'); },
      } as unknown as AttachmentStore,
    });
    await expect(prepareTurn(deps, makeRuntime(makeStart({
      attachments: [{ sourcePath: '/x.png' }],
    })))).rejects.toThrow(TurnPreparationError);
  });

  it('模型不支持图片且存在图片附件时记录降级通知', async () => {
    const image: Attachment = {
      id: 'att-1',
      kind: 'image',
      name: 'a.png',
      mimeType: 'image/png',
      imagePath: '/nonexistent.png',
      sourcePath: '/x/a.png',
    } as Attachment;
    const deps = makeDeps({
      providerModels: {
        get: () => ({ capability: 'llm', contextWindow: 128_000, inputImage: false }),
      } as unknown as ProviderModels,
      attachments: { addAll: async () => [image] } as unknown as AttachmentStore,
      describeImage: async () => '一只猫',
    });
    const prepared = await prepareTurn(deps, makeRuntime(makeStart({
      attachments: [{ sourcePath: '/x/a.png' }],
    })));
    expect(prepared.degradations).toHaveLength(1);
    expect(prepared.degradations[0]).toMatchObject({ removed: ['image'] });
    expect(JSON.stringify(prepared.userMessageParts)).toContain('一只猫');
  });
});
