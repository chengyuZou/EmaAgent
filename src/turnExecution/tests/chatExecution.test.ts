// 测试 Chat 通过统一 AgentLoop 执行时的只读工具边界、Narrative 与 reasoning 往返。

import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_SETTINGS } from '@ema-agent/agent';
import { DEFAULT_CONTEXT_COMPACTION_SETTINGS } from '@ema-agent/context';
import type { MessageId, SessionId, TurnId } from '@ema-agent/ids';
import type { LlmRequest } from '@ema-agent/llm';
import type { Message, Turn } from '@ema-agent/session';
import { ToolRegistry } from '@ema-agent/tools';
import { registerBuiltinTools } from '@ema-agent/tool-builtin';
import { TurnExecutor } from '../turnExecutor.js';
import { RootAgentExecution } from '../rootAgentExecution.js';
import { TurnContextBuilder } from '../turnContext.js';
import { TurnToolsBuilder } from '../turnTools.js';

const sessionId = 'session-chat-unified' as SessionId;
const turnId = 'turn-chat-unified' as TurnId;
const prompt = {
  slots: [],
  systemBlocks: [{
    stabilityScope: 'product',
    delivery: 'system',
    content: 'You are Ema.',
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
} as const;

describe('Chat 统一执行链', () => {
  it('只暴露只读工具，并保留 Narrative 块与 reasoning signature', async () => {
    const requests: LlmRequest[] = [];
    const messages: Message[] = [];
    let messageSequence = 0;
    const controller = new AbortController();
    const turn: Turn = {
      id: turnId,
      sessionId,
      triggerType: 'userMessage',
      executionProfile: 'chat',
      narrativePolicy: 'always',
      status: 'running',
      userInput: '第一周目发生了什么？',
      startedAt: Date.now(),
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      iterations: 0,
      usageInputTokens: 0,
      usageOutputTokens: 0,
    };
    const session = {
      startTurn: () => ({ turn, signal: controller.signal }),
      requestAbort: (_sessionId, _turnId) => controller.abort(),
      clearRunning: (_sessionId, _turnId) => undefined,
      loadHistory: () => [],
      appendMessage: (input: {
        turnId: TurnId;
        sessionId: SessionId;
        role: Message['role'];
        kind?: Message['kind'];
        blocks: Message['blocks'];
      }): Message => {
        const message: Message = {
          id: `message-${++messageSequence}` as MessageId,
          turnId: input.turnId,
          sessionId: input.sessionId,
          role: input.role,
          kind: input.kind ?? 'normal',
          blocks: input.blocks,
          interrupted: false,
          createdAt: Date.now(),
        };
        messages.push(message);
        return message;
      },
      completeTurn: () => undefined,
      failTurn: () => undefined,
      abortTurn: () => undefined,
    };
    const tools = new ToolRegistry();
    registerBuiltinTools(tools);
    const narrative = {
      recall: async () => ({
        generationId: 'generation-1',
        routes: { '1st_Loop': '第一周目' },
        results: { '1st_Loop': '第一周目召回正文' },
        failures: [],
      }),
    };
    let llmCallCount = 0;
    const llm = {
      stream: async function* (request: LlmRequest) {
        requests.push(request);
        llmCallCount += 1;
        if (llmCallCount === 1) {
          yield { type: 'thinking_delta' as const, blockIndex: 0, delta: '分析' };
          yield {
            type: 'thinking_complete' as const,
            blockIndex: 0,
            signature: 'signature-1',
          };
          yield { type: 'text_delta' as const, blockIndex: 1, delta: '回答前半' };
          yield { type: 'done' as const, stopReason: 'max_tokens' as const };
          return;
        }
        // 新 Provider 调用的 blockIndex 会从零开始，不能覆盖前一段文本。
        yield { type: 'text_delta' as const, blockIndex: 0, delta: '后半' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      },
    } as never;
    const emotion = {
      beginTurn: () => undefined,
      processChunk: (delta: string) => ({ cleaned: delta, events: [] }),
      flush: () => ({ cleaned: '', events: [] }),
    } as never;
    const executor = new TurnExecutor({
      session: session as never,
      interactions: { cancelForTurn: () => 0 },
    }, new RootAgentExecution({
      transcript: session as never,
      llm,
      emotion,
    }, new TurnContextBuilder({
        session: session as never,
        narrative: narrative as never,
      }), new TurnToolsBuilder({
        session: session as never,
        llm,
        narrative: narrative as never,
        tools,
        permission: {} as never,
        knowledgeSearch: async () => ({ items: [] }) as never,
      })));

    const handle = executor.start({
      sessionId,
      triggerType: 'userMessage',
      executionProfile: 'chat',
      narrativePolicy: 'always',
      userInput: turn.userInput,
      prepare: () => ({
        userInput: turn.userInput,
        persistedUserInput: turn.userInput,
        prompt,
        model: {
          providerId: 'provider-1',
          model: 'model-1',
          capabilities: {
          input: {
            text: 'supported' as const,
            image: 'supported' as const,
            audio: 'supported' as const,
            file: 'supported' as const,
          },
          tools: 'supported' as const,
          reasoning: 'supported' as const,
          temperature: 'supported' as const,
          contextWindow: 200_000,
          source: 'manual' as const,
          },
        },
        settings: {
          agent: DEFAULT_AGENT_SETTINGS,
          contextCompaction: DEFAULT_CONTEXT_COMPACTION_SETTINGS,
          permissionMode: 'default',
        },
        workspaceRoot: process.cwd(),
        requestDegradations: [],
      }),
    });
    const events = [];
    for await (const event of handle.events) events.push(event);

    const outcome = await handle.completion;
    expect(outcome).toMatchObject({ status: 'completed' });
    const toolNames = requests[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('KnowledgeBaseSearch');
    expect(toolNames).not.toContain('NarrativeSearch');
    expect(toolNames).not.toContain('Write');
    expect(toolNames).not.toContain('Bash');
    expect(toolNames).not.toContain('TaskCreate');
    expect(toolNames).not.toContain('SkillCall');
    expect(toolNames).not.toContain('Subagent');
    expect(requests).toHaveLength(2);

    expect(requests[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('第一周目召回正文'),
      }),
    ]));
    expect(events).toContainEqual({
      type: 'reasoning_complete',
      sessionId,
      turnId,
      blockIndex: 0,
    });
    expect(messages).toContainEqual(expect.objectContaining({
      kind: 'narrative_context',
      blocks: {
        timelines: [{
          name: '1st_Loop',
          charCount: 8,
          text: '第一周目召回正文',
        }],
      },
    }));
    expect(messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      blocks: [
        { type: 'thinking', thinking: '分析', signature: 'signature-1' },
        { type: 'text', text: '回答前半后半' },
      ],
    }));
  });
});
