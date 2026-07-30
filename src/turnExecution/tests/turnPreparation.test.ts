// 测试 TurnInputPreparer 只解析一次模型能力，并产出不含行为回调的冻结输入。

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_SETTINGS } from '@ema-agent/agent';
import { DEFAULT_CONTEXT_COMPACTION_SETTINGS } from '@ema-agent/context';
import { DEFAULT_ATTACHMENT_SETTINGS } from '@ema-agent/attachment';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import { TurnInputPreparer } from '../turnPreparation.js';

describe('TurnInputPreparer', () => {
  it('冻结模型、Prompt 与工作区事实，不把运行时服务塞进 TurnInput', async () => {
    const resolve = vi.fn(() => ({
      input: {
        text: 'supported' as const,
        image: 'unknown' as const,
        audio: 'unknown' as const,
        file: 'unknown' as const,
      },
      tools: 'supported' as const,
      reasoning: 'supported' as const,
      temperature: 'supported' as const,
      contextWindow: 64_000,
      maxOutput: 4_096,
      source: 'manual' as const,
    }));
    const turnSettings = {
      agent: { ...DEFAULT_AGENT_SETTINGS, workMaxIterations: 41 },
      attachment: {
        ...DEFAULT_ATTACHMENT_SETTINGS,
        maxImagesPerTurn: 4,
      },
      contextCompaction: {
        ...DEFAULT_CONTEXT_COMPACTION_SETTINGS,
        bufferTokens: 14_000,
      },
    };
    const settingsForTurn = vi.fn(() => turnSettings);
    const preparer = new TurnInputPreparer({
      session: {
        getSession: () => ({ workspaceRoot: 'D:\\workspace' }) as never,
      },
      attachments: {
        addAll: () => [],
        resolveForPrompt: () => ({ imageParts: [], promptLines: '' }),
      },
      modelCapabilities: { resolve },
      contextWindowFor: () => 128_000,
      activeCharacter: () => ({
        id: 'seed',
        name: 'Ema',
        version: '1',
        description: null,
        systemPrompt: '你是 Ema。',
        speechPatterns: [],
        forbiddenTopics: [],
        emotionVocabulary: [],
        motionVocabulary: [],
        live2dVariants: [],
        portraits: [],
        voiceReferences: [],
        isActive: true,
        isBuiltin: true,
        createdAt: 1,
        updatedAt: 1,
      } as never),
      mediaCompatibility: {
        visionBinding: () => undefined,
        describeImage: async () => '',
      },
      scratchpadDirForTurn: () => 'D:\\scratchpad\\turn-1',
      settingsForTurn,
    });

    const input = await preparer.prepare({
      executionProfile: 'work',
      narrativePolicy: 'auto',
      userInput: 'hello',
      providerId: 'provider-1',
      model: 'model-1',
      kbIds: ['kb-1'],
    }, {
      turn: {
        id: asTurnId('turn-1'),
        sessionId: asSessionId('session-1'),
      } as never,
      signal: new AbortController().signal,
    });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(settingsForTurn).toHaveBeenCalledTimes(1);
    expect(input.model).toMatchObject({
      providerId: 'provider-1',
      model: 'model-1',
      capabilities: {
        contextWindow: 128_000,
        maxOutput: 4_096,
      },
    });
    expect(input.persistedUserInput).toBe('hello');
    expect(input.workspaceRoot).toBe('D:\\workspace');
    expect(input.scratchpadDir).toBe('D:\\scratchpad\\turn-1');
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.model)).toBe(true);
    expect(Object.isFrozen(input.model.capabilities.input)).toBe(true);
    expect(Object.isFrozen(input.settings.agent)).toBe(true);
    expect(Object.isFrozen(input.settings.attachment)).toBe(true);
    expect(Object.isFrozen(input.settings.contextCompaction)).toBe(true);
    turnSettings.agent.workMaxIterations = 42;
    turnSettings.attachment.maxImagesPerTurn = 5;
    expect(input.settings.agent.workMaxIterations).toBe(41);
    expect(input.settings.attachment.maxImagesPerTurn).toBe(4);
    expect(Object.keys(input)).not.toContain('compactContext');
    expect(Object.keys(input)).not.toContain('prepareContextContributions');
  });
});
