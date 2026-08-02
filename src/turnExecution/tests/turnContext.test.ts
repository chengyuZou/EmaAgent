// 测试根 Turn 的历史投影、临时业务贡献、压缩调用和领域事件转发。

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_SETTINGS } from '@ema-agent/agent';
import { DEFAULT_CONTEXT_COMPACTION_SETTINGS, type ContextCompactor } from '@ema-agent/context';
import type { SessionId, TaskId, TurnId } from '@ema-agent/ids';
import type { MemoryRecallPort } from '@ema-agent/memory';
import type { Turn } from '@ema-agent/session';
import type { Task, TaskStorePort } from '@ema-agent/tasks';
import type { TurnInput } from '../types.js';
import {
  TurnContextBuilder,
  type TurnContextEvent,
} from '../turnContext.js';

const sessionId = 'session-context' as SessionId;
const turnId = 'turn-context' as TurnId;

const turn: Turn = {
  id: turnId,
  sessionId,
  triggerType: 'userMessage',
  executionProfile: 'work',
  narrativePolicy: 'off',
  status: 'running',
  userInput: 'hello',
  startedAt: 1,
  completedAt: null,
  errorCode: null,
  errorMessage: null,
  iterations: 0,
  usageInputTokens: 0,
  usageOutputTokens: 0,
};

const input: TurnInput = {
  userInput: 'hello',
  persistedUserInput: 'hello',
  prompt: {
    slots: [],
    systemBlocks: [{
      stabilityScope: 'product',
      delivery: 'system',
      content: 'system',
      revision: 'product-v1',
      cacheBreakpoint: true,
    }],
    contextBlocks: [],
    revisions: {
      product: 'product-v1',
      activeCharacter: 'character-v1',
      turn: 'turn-v1',
      complete: 'prompt-v1',
    },
    revision: 'prompt-v1',
  },
  model: {
    providerId: 'provider',
    model: 'model',
    capabilities: {
      input: {
        text: 'supported',
        image: 'supported',
        audio: 'supported',
        file: 'supported',
      },
      tools: 'supported',
      reasoning: 'supported',
      temperature: 'supported',
      contextWindow: 100_000,
      maxOutput: 4_096,
      source: 'manual',
    },
  },
  settings: {
    agent: DEFAULT_AGENT_SETTINGS,
    contextCompaction: DEFAULT_CONTEXT_COMPACTION_SETTINGS,
  },
  workspaceRoot: 'D:\\workspace',
  requestDegradations: [],
};

const emptyManifest = {
  registryVersion: 1,
  revision: 'tools-v1',
  entries: [],
} as const;

describe('TurnContextBuilder', () => {
  it('并发执行 Narrative 与 Memory 召回，并按固定顺序组装贡献', async () => {
    const started: string[] = [];
    let finishNarrative!: () => void;
    let finishMemory!: () => void;
    const narrativeGate = new Promise<void>((resolve) => {
      finishNarrative = resolve;
    });
    const memoryGate = new Promise<void>((resolve) => {
      finishMemory = resolve;
    });
    const builder = new TurnContextBuilder({
      session: { loadHistory: () => [] } as never,
      narrative: {
        recall: async () => {
          started.push('narrative');
          await narrativeGate;
          return {
            generationId: 'generation-1',
            routes: { timeline: 'route' },
            results: { timeline: 'narrative fact' },
            failures: [],
          };
        },
      } as never,
      memory: {
        prepareRecallContribution: async () => {
          started.push('memory');
          await memoryGate;
          return {
            contribution: {
              id: 'memory.recall',
              source: 'memory',
              placement: 'beforeCurrentTurn',
              message: { role: 'user', content: 'memory fact' },
            },
            recallSummary: { layer0: 0, layer1: false, layer2: 1 },
            tokenEstimate: 2,
          };
        },
      },
    });
    const preparing = builder.prepare({
      turn: { ...turn, narrativePolicy: 'always' },
      input,
      signal: new AbortController().signal,
    });

    await Promise.resolve();
    expect(started).toEqual(['narrative', 'memory']);
    finishMemory();
    finishNarrative();
    const prepared = await preparing;
    const snapshot = await prepared.assemble({
      history: [],
      currentTurn: prepared.messages,
      mailboxMessages: [],
      activeSkills: [],
      toolManifest: emptyManifest,
      forceCompaction: false,
    });
    const contents = snapshot.messages.map((message) => message.content);
    const narrativeIndex = contents.findIndex(
      (content) => typeof content === 'string' && content.includes('narrative fact'),
    );
    const memoryIndex = contents.indexOf('memory fact');
    const userIndex = contents.indexOf('hello');

    expect(narrativeIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeGreaterThan(narrativeIndex);
    expect(userIndex).toBeGreaterThan(memoryIndex);
  });

  it('把 Memory 与 Task 投影成临时贡献，并把 Memory 证据事件交还当前 Turn', async () => {
    const events: TurnContextEvent[] = [];
    const memory: MemoryRecallPort = {
      prepareRecallContribution: async (request) => {
        request.emit?.({
          type: 'memory_recall_evidence',
          sessionId,
          turnId,
          executionProfile: 'work',
          layer: 'layer1',
          report: {
            status: 'succeeded',
            itemCount: 1,
            tokenEstimate: 4,
            durationMs: 2,
          },
        });
        return {
          contribution: {
            id: 'memory.recall',
            source: 'memory',
            placement: 'beforeCurrentTurn',
            message: { role: 'user', content: 'remembered fact' },
          },
          recallSummary: { layer0: 0, layer1: true, layer2: 0 },
          tokenEstimate: 4,
        };
      },
    };
    const task: Task = {
      id: 'task-1' as TaskId,
      sessionId,
      displayNumber: 1,
      subject: 'finish context migration',
      description: '',
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
      createdByTurnId: turnId,
      version: 3,
      createdAt: 1,
      updatedAt: 1,
    };
    const tasks = {
      takeContextReminder: vi.fn(() => [task]),
    } as unknown as TaskStorePort;
    const builder = new TurnContextBuilder({
      session: {
        loadHistory: () => [],
      } as never,
      memory,
      tasks,
    });

    const prepared = await builder.prepare({
      turn,
      input,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });
    const snapshot = await prepared.assemble({
      history: [],
      currentTurn: prepared.messages,
      mailboxMessages: [],
      activeSkills: [],
      toolManifest: emptyManifest,
      forceCompaction: false,
    });

    expect(events.map((event) => event.type)).toContain('memory_recall_evidence');
    expect(tasks.takeContextReminder).toHaveBeenCalledWith(sessionId);
    expect(snapshot.messages.map((message) => message.content)).toEqual(
      expect.arrayContaining([
        'remembered fact',
        expect.stringContaining('finish context migration'),
        'hello',
      ]),
    );
  });

  it('Memory 召回抛错时降级为空贡献并发出不可用事件，不阻断准备', async () => {
    const events: TurnContextEvent[] = [];
    const memory: MemoryRecallPort = {
      prepareRecallContribution: async () => {
        throw new Error('sqlite: database is locked');
      },
    };
    const builder = new TurnContextBuilder({
      session: {
        loadHistory: () => [],
      } as never,
      memory,
    });

    const prepared = await builder.prepare({
      turn,
      input,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });
    const snapshot = await prepared.assemble({
      history: [],
      currentTurn: prepared.messages,
      mailboxMessages: [],
      activeSkills: [],
      toolManifest: emptyManifest,
      forceCompaction: false,
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'memory_recall_unavailable',
        sessionId,
        turnId,
        retryable: true,
      }),
    ]);
    expect(snapshot.messages.map((message) => message.content)).not.toContain('remembered fact');
    expect(snapshot.messages.map((message) => message.content)).toContain('hello');
  });

  it('每次 assemble 都把强制压缩标记和 Context 事件传给现有 Compactor', async () => {
    const forces: Array<boolean | undefined> = [];
    const events: TurnContextEvent[] = [];
    const compactor = {
      compact: async (args: {
        force?: boolean;
        prefixMessages?: readonly unknown[];
        messages: unknown[];
        suffixMessages?: readonly unknown[];
        emit?: (event: TurnContextEvent) => void;
      }) => {
        forces.push(args.force);
        args.emit?.({
          type: 'context_compaction_started',
          compactionId: 'compaction-1' as never,
          sessionId,
          turnId,
          executionProfile: 'work',
          narrativePolicy: 'off',
          beforeTokens: 10,
        });
        return {
          status: 'not_needed',
          macroRan: false,
          reason: 'below_threshold',
          messages: [
            ...(args.prefixMessages ?? []),
            ...args.messages,
            ...(args.suffixMessages ?? []),
          ],
          microCleared: 0,
          beforeTokens: 10,
          afterTokens: 10,
          savedTokens: 0,
        };
      },
    } as unknown as ContextCompactor;
    const builder = new TurnContextBuilder({
      session: { loadHistory: () => [] } as never,
      compactor,
    });
    const prepared = await builder.prepare({
      turn,
      input,
      signal: new AbortController().signal,
    });

    await prepared.assemble({
      history: [],
      currentTurn: prepared.messages,
      mailboxMessages: [],
      activeSkills: [],
      toolManifest: emptyManifest,
      forceCompaction: true,
      emit: (event) => events.push(event),
    });

    expect(forces).toEqual([true]);
    expect(events.map((event) => event.type)).toEqual([
      'context_compaction_started',
    ]);
  });
});
