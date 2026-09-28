// 验证 fork 的固定父前缀, 工具配对占位和 System 继承; 普通子代理保持独立上下文.
import { describe, expect, it, vi } from 'vitest';
import type { CallLlm, Message } from '@ema-agent/llm';
import type { CompactRequest } from '@ema-agent/compact';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import { ToolPool } from '@ema-agent/tools';
import { createPrepareSubagent, type ForkParentMessages } from '../prepare/prepareSubagent.js';
import type { PreparedTurn } from '../prepare/prepareTurn.js';

const callLlm: CallLlm = async function* () {
  yield { type: 'done', stopReason: 'end_turn' };
};

function preparedTurn(): PreparedTurn {
  return {
    providerId: 'p',
    modelId: 'm',
    protocol: 'openai-chat',
    callLlm,
    contextWindow: 100_000,
    maxOutput: 8_000,
    systemPrompt: [{ name: 'root', content: '根提示词' }],
    tools: {
      toolPool: new ToolPool([]),
      createSubagentExecutor: () => undefined,
    },
    maxIterations: 10,
  } as unknown as PreparedTurn;
}

function parentMessages(): ForkParentMessages {
  return {
    history: [{ role: 'user', content: '父工作历史' }],
    assistant: {
      role: 'assistant',
      generatedBy: { providerId: 'p', modelId: 'm', protocol: 'openai-chat' },
      content: [
        { type: 'text', text: '并行检查两个问题' },
        { type: 'thinking', thinking: '父推理', signature: 'signature' },
        { type: 'tool_use', id: 'call-a', name: 'Subagent', args: { prompt: '查接口' } },
        { type: 'tool_use', id: 'call-b', name: 'Subagent', args: { prompt: '查测试' } },
      ],
    },
  };
}

function fixture(readParentMessages: (signal: AbortSignal) => Promise<ForkParentMessages>) {
  const prepared = preparedTurn();
  const createCompact = vi.fn((_call: CallLlm) => async (request: CompactRequest) => ({
    kind: 'unchanged' as const,
    messages: request.messages,
  }));
  const prepare = createPrepareSubagent({
    sessionId: 's1', turnId: 't1',
    prepared: () => prepared,
    providers: {} as Providers,
    providerModels: {} as ProviderModels,
    createCompact,
    emit: () => undefined,
    readParentMessages,
  });
  return { prepare, createCompact };
}

describe('createPrepareSubagent fork', () => {
  it('兄弟 fork 保留完整父 Assistant, 统一占位配对, 只在最后指令分歧', async () => {
    const parent = parentMessages();
    const before = JSON.stringify(parent);
    const { prepare, createCompact } = fixture(async () => parent);
    const signal = new AbortController().signal;
    const first = await prepare({
      subagentId: 'a1',
      prompt: '查接口',
      options: { contextMode: 'fork', systemPrompt: '只读接口角色' },
      signal,
    });
    const second = await prepare({
      subagentId: 'a2',
      prompt: '查测试',
      options: { contextMode: 'fork', systemPrompt: '只读测试角色' },
      signal,
    });

    expect(createCompact).toHaveBeenCalledTimes(2);
    expect(first.messages.slice(0, -1)).toEqual(second.messages.slice(0, -1));
    expect(first.messages[1]).toEqual(parent.assistant);
    expect(first.messages[2]!.content).toEqual([
      { type: 'tool_result', toolCallId: 'call-a', content: expect.any(String) },
      { type: 'tool_result', toolCallId: 'call-b', content: expect.any(String) },
    ]);
    expect(JSON.stringify(parent)).toBe(before);
    expect(first.messages.at(-1)!.content).toContain('只读接口角色');
    expect(first.messages.at(-1)!.content).toContain('backgroundProcessId');
    expect(first.messages.at(-1)!.content).toContain('查接口');
    expect(second.messages.at(-1)!.content).toContain('查测试');
    const request = await first.prepareIteration({ llmCallId: 'llm-a', messages: first.messages });
    expect(request.request.messages[0]).toEqual({ role: 'system', content: '根提示词' });
    expect(first.messages.some(message => message.role === 'system')).toBe(false);
  });

  it('父 Assistant 完整前不交付子循环输入, 后续父历史变化不进入已分叉消息', async () => {
    let resolve!: (value: ForkParentMessages) => void;
    const ready = new Promise<ForkParentMessages>(done => { resolve = done; });
    const { prepare } = fixture(() => ready);
    let completed = false;
    const pending = prepare({
      subagentId: 'a1', prompt: '查接口', options: { contextMode: 'fork' },
      signal: new AbortController().signal,
    }).then(result => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    const parent = parentMessages();
    resolve(parent);
    const child = await pending;
    (parent.history as Message[]).push({ role: 'user', content: '父后续消息' });
    expect(JSON.stringify(child.messages)).not.toContain('父后续消息');
  });

  it('父输入准备失败时不交付 fork 循环', async () => {
    const error = new Error('父模型断流');
    const { prepare } = fixture(async () => { throw error; });
    await expect(prepare({
      subagentId: 'a1', prompt: '查接口', options: { contextMode: 'fork' },
      signal: new AbortController().signal,
    })).rejects.toBe(error);
  });

  it('普通子代理不读取父消息, 保留自己的角色提示词和后台任务交接说明', async () => {
    const readParentMessages = vi.fn(async () => parentMessages());
    const { prepare } = fixture(readParentMessages);
    const child = await prepare({
      subagentId: 'a1', prompt: '独立调查',
      options: { contextMode: 'subagent', systemPrompt: '独立角色' },
      signal: new AbortController().signal,
    });
    expect(readParentMessages).not.toHaveBeenCalled();
    expect(child.messages).toHaveLength(1);
    expect(child.messages[0]!.content).toContain('backgroundProcessId');
    expect(child.messages[0]!.content).toContain('独立调查');
    const request = await child.prepareIteration({ llmCallId: 'llm-a', messages: child.messages });
    expect(request.request.messages[0]).toEqual({ role: 'system', content: '独立角色' });
    expect(JSON.stringify(request.request.messages)).not.toContain('父工作历史');
  });
});
