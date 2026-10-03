// 验证 fork 的固定父前缀与工具配对; 各子代理按自身能力装配纯工作 System.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallLlm } from '@ema-agent/llm';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import { staticSystemPrompt, getDynamicSystemPrompt, type DynamicSystemPromptInput } from '@ema-agent/prompts';
import { ToolPool } from '@ema-agent/tools';
import { createPrepareSubagent } from '../prepare/prepareSubagent.js';
import type { PreparedTurn } from '../prepare/prepareTurn.js';
import { GoalGetTool } from '../../builtin-tools/tools/GoalGetTool/GoalGetTool.js';
import { GoalUpdateTool } from '../../builtin-tools/tools/GoalUpdateTool/GoalUpdateTool.js';

import { Database, SubagentsRepo, SubagentRunsRepo, SubagentMessagesRepo } from '@ema-agent/storage';
import { SubagentMessagesStore, type ForkParentMessages, type ForkParentMessage, type PrepareSubagentInput } from '@ema-agent/agent';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const callLlm: CallLlm = async function* () {
  yield { type: 'done', stopReason: 'end_turn' };
};

function preparedTurn(): PreparedTurn {
  const dynamicInput: DynamicSystemPromptInput = {
    characterPrompt: () => ['根角色人设'],
    sessionMode: 'work',
    permissionMode: 'default',
    toolNames: [],
    environment: { platform: 'win32', cwd: 'D:/workspace', projectFolderPaths: [], providerId: 'p', modelId: 'm' },
    workspaceInstructions: '本工作区约定',
    memorySection: '本轮记忆指引',
    skillCatalog: '本轮技能目录',
  };
  return {
    providerId: 'p',
    modelId: 'm',
    protocol: 'openai-llm',
    callLlm,
    contextWindow: 100_000,
    maxOutput: 8_000,
    DynamicSystemPromptInput: dynamicInput,
    systemPrompt: [...staticSystemPrompt, ...getDynamicSystemPrompt(dynamicInput)],
    tools: {
      toolPool: new ToolPool([]),
      createSubagentExecutor: () => undefined,
    },
    maxIterations: 10,
  } as unknown as PreparedTurn;
}

function parentMessages(): ForkParentMessages {
  return {
    messages: [{
      id: 'parent-user', role: 'user', kind: 'normal', blocks: '父工作历史',
      interrupted: false, createdAt: 1, summarizedThroughMessageId: null,
    }, {
      id: 'parent-assistant', kind: 'normal', interrupted: false, createdAt: 2, summarizedThroughMessageId: null,
      role: 'assistant',
      generatedBy: { providerId: 'p', modelId: 'm', protocol: 'openai-llm' },
      blocks: [
        { type: 'text', text: '并行检查两个问题' },
        { type: 'thinking', thinking: '父推理', signature: 'signature' },
        { type: 'tool_use', id: 'call-a', name: 'Subagent', args: { prompt: '查接口' } },
        { type: 'tool_use', id: 'call-b', name: 'Subagent', args: { prompt: '查测试' } },
      ],
    }],
  };
}

function fixture(
  readParentMessages: (signal: AbortSignal) => Promise<ForkParentMessages>,
  prepared: PreparedTurn = preparedTurn(),
) {
  const createCompact = vi.fn((_call: CallLlm): ((request: CompactRequest) => Promise<CompactResult>) => async request => ({
    kind: 'unchanged' as const,
    messages: request.messages,
  }));
  const prepareChild = createPrepareSubagent({
    sessionId: 's1', turnId: 't1',
    prepared: () => prepared,
    providers: {} as Providers,
    providerModels: {} as ProviderModels,
    createCompact,
    emit: () => undefined,
    readParentMessages,
  });
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  db.sqlite.prepare("INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES ('s1', '会话', '', 1, 1)").run();
  databases.push(db);
  const identities = new SubagentsRepo(db.sqlite);
  const runs = new SubagentRunsRepo(db.sqlite);
  const messages = new SubagentMessagesStore(new SubagentMessagesRepo(db.sqlite));
  const prepare = (input: Pick<PrepareSubagentInput, 'subagentId' | 'prompt' | 'options' | 'signal'>) => {
    const runId = input.subagentId + '-run';
    identities.insert({ id: input.subagentId, sessionId: 's1', title: '调查', description: '调查', createdAt: 1 });
    runs.insert({ id: runId, subagentId: input.subagentId, contextMode: input.options.contextMode ?? 'subagent', createdAt: 1 });
    return prepareChild({ ...input, runId, isNew: true, messageStore: messages, messageIds: [] });
  };
  return { prepare, createCompact, messages, runs, prepareChild };
}

describe('createPrepareSubagent fork', () => {
  it('子循环 Macro 将摘要和覆盖 ID 写入本次 Run, 同步更新模型历史的 ID 前缀', async () => {
    const { prepare, createCompact, messages } = fixture(async () => parentMessages());
    createCompact.mockReturnValue(async request => {
      request.saveMacroSummary?.('子任务阶段摘要', request.messages.length, 50);
      return { kind: 'macro', messages: [{ role: 'user', content: '子任务阶段摘要' }],
        summarizedMessageCount: request.messages.length, beforeTokens: 100, afterTokens: 50,
        savedTokens: 50, durationMs: 1 };
    });
    const child = await prepare({ subagentId: 'child', prompt: '独立调查', options: { contextMode: 'subagent' },
      signal: new AbortController().signal });
    const task = messages.loadHistory('child').at(-1)!;
    const iteration = await child.prepareIteration({ llmCallId: 'call', messages: child.messages });
    expect(iteration.messages).toEqual([{ role: 'user', content: '子任务阶段摘要' }]);
    expect(messages.loadHistory('child')).toMatchObject([{ kind: 'summary', blocks: '子任务阶段摘要',
      runId: 'child-run', savedTokens: 50, summarizedThroughMessageId: task.id }]);
  });

  it('fork 保留摘要正文和节省 Token, 覆盖旧 ID 不在副本中时以摘要自身为边界', async () => {
    const parent = parentMessages();
    const summary: ForkParentMessage = {
      id: 'summary', role: 'user', kind: 'summary', blocks: '已完成事项摘要',
      interrupted: false, createdAt: 0, summarizedThroughMessageId: 'not-copied', savedTokens: 80,
    };
    const { prepare, messages } = fixture(async () => ({ messages: [summary, ...parent.messages] }));
    const child = await prepare({
      subagentId: 'child', prompt: '继续调查', options: { contextMode: 'fork' },
      signal: new AbortController().signal,
    });
    expect(child.messages[0]).toEqual({ role: 'user', content: '已完成事项摘要' });
    const saved = messages.loadHistory('child');
    expect(saved[0]).toMatchObject({ kind: 'summary', blocks: summary.blocks, savedTokens: 80,
      summarizedThroughMessageId: null, runId: null });
    expect(saved[0]!.id).not.toBe(summary.id);
    expect(saved.some(message => message.id === 'not-copied')).toBe(false);
  });

  it('继续旧 ID 重放自身完整历史, 只追加本次任务, 不再次读取父 fork', async () => {
    const readParentMessages = vi.fn(async () => parentMessages());
    const { prepare, prepareChild, messages, runs } = fixture(readParentMessages);
    await prepare({ subagentId: 'child', prompt: '第一次调查', options: { contextMode: 'fork' },
      signal: new AbortController().signal });
    runs.setRunConfiguration('child-run', {
      providerId: 'p', modelId: 'm', protocol: 'openai-llm', permissionMode: 'default', reasoningEffort: 'high',
    }, 2);
    messages.record('child', 'child-run', {
      type: 'assistant_message_completed',
      iteration: 1,
      llmCallId: 'first-child-call',
      stopReason: 'end_turn',
      content: [{ type: 'text', text: '第一次结论' }],
    });
    runs.completeRun('child-run', { finalText: '第一次结论', iterations: 1, toolCallCount: 0, inputTokens: 1, outputTokens: 1 }, 3);
    runs.startRun({ id: 'second-run', subagentId: 'child', contextMode: 'fork', createdAt: 4 });
    const messageIds: (string | undefined)[] = [];
    const second = await prepareChild({
      subagentId: 'child', runId: 'second-run', isNew: false, prompt: '纠正第一次结论',
      options: { contextMode: 'fork' }, messageStore: messages, messageIds, signal: new AbortController().signal,
    });
    expect(readParentMessages).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(second.messages)).toContain('第一次结论');
    expect(second.messages.at(-1)).toEqual({ role: 'user', content: '纠正第一次结论' });
    expect(second.messages.filter(message => message.role === 'user' && message.content === '父工作历史')).toHaveLength(1);
    expect(messageIds).toHaveLength(second.messages.length);
    expect(messages.loadHistory('child').at(-1)).toMatchObject({ runId: 'second-run', blocks: '纠正第一次结论' });
  });

  it.each(['fork', 'subagent'] as const)('%s 子代理不继承根 Goal 工具', async contextMode => {
    const base = preparedTurn();
    const root = {
      ...base,
      tools: { ...base.tools, toolPool: new ToolPool([GoalGetTool, GoalUpdateTool]) },
    };
    const { prepare } = fixture(async () => parentMessages(), root);
    const child = await prepare({
      subagentId: 'child', prompt: '只处理子任务', options: { contextMode },
      signal: new AbortController().signal,
    });
    const prepared = await child.prepareIteration({ llmCallId: 'child-call', messages: child.messages });
    expect(prepared.request.tools).toEqual([]);
    expect(root.tools.toolPool.tools.map(tool => tool.name)).toEqual(['GoalGet', 'GoalUpdate']);
  });

  it('兄弟 fork 保留完整父 Assistant, 统一占位配对, 只在最后指令分歧', async () => {
    const parent = parentMessages();
    const before = JSON.stringify(parent);
    const { prepare, createCompact } = fixture(async () => parent);
    const signal = new AbortController().signal;
    const first = await prepare({
      subagentId: 'a1',
      prompt: '查接口',
      options: { contextMode: 'fork' },
      signal,
    });
    const second = await prepare({
      subagentId: 'a2',
      prompt: '查测试',
      options: { contextMode: 'fork' },
      signal,
    });

    expect(createCompact).toHaveBeenCalledTimes(2);
    expect(first.messages.slice(0, -1)).toEqual(second.messages.slice(0, -1));
    expect(first.messages[1]).toEqual({
      role: 'assistant', content: parent.messages[1]!.blocks,
      generatedBy: parent.messages[1]!.generatedBy,
    });
    expect(first.messages[2]!.content).toEqual([
      { type: 'tool_result', toolCallId: 'call-a', content: expect.any(String) },
      { type: 'tool_result', toolCallId: 'call-b', content: expect.any(String) },
    ]);
    expect(JSON.stringify(parent)).toBe(before);
    expect(first.messages.at(-2)!.content).toContain('backgroundProcessId');
    expect(first.messages.at(-1)!.content).toContain('查接口');
    expect(second.messages.at(-1)!.content).toContain('查测试');
    const request = await first.prepareIteration({ llmCallId: 'llm-a', messages: first.messages });
    expect(request.request.messages[0]).toMatchObject({ role: 'system', content: staticSystemPrompt[0]!.content });
    const system = request.request.messages.filter(message => message.role === 'system');
    expect(JSON.stringify(system)).not.toContain('根角色人设');
    expect(JSON.stringify(system)).not.toContain('当前执行方式：Work');
    expect(system.at(-1)!.content).toContain('纯工作子代理');
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
    (parent.messages as ForkParentMessage[]).push({
      id: 'later', role: 'user', kind: 'normal', blocks: '父后续消息',
      interrupted: false, createdAt: 3, summarizedThroughMessageId: null,
    });
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

  it('普通子代理不读取父消息, 使用工作提示词和后台任务交接说明', async () => {
    const readParentMessages = vi.fn(async () => parentMessages());
    const { prepare } = fixture(readParentMessages);
    const child = await prepare({
      subagentId: 'a1', prompt: '独立调查',
      options: { contextMode: 'subagent' },
      signal: new AbortController().signal,
    });
    expect(readParentMessages).not.toHaveBeenCalled();
    expect(child.messages).toHaveLength(2);
    expect(child.messages[0]!.content).toContain('backgroundProcessId');
    expect(child.messages[1]!.content).toBe('独立调查');
    const request = await child.prepareIteration({ llmCallId: 'llm-a', messages: child.messages });
    expect(request.request.messages[0]).toMatchObject({ role: 'system', content: staticSystemPrompt[0]!.content });
    const system = request.request.messages.filter(message => message.role === 'system');
    const text = JSON.stringify(system);
    expect(text).not.toContain('根角色人设');
    expect(text).not.toContain('当前执行方式：Work');
    expect(text).toContain('本工作区约定');
    expect(text).toContain('本轮记忆指引');
    expect(text).toContain('本轮技能目录');
    expect(text).toContain('p / m');
    expect(system.at(-1)!.content).toContain('backgroundProcessId');
    expect(JSON.stringify(request.request.messages)).not.toContain('父工作历史');
  });
});
