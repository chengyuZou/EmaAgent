// 验证 OpenAI Chat 的用户取消、静默断流和 finish_reason 后 Usage 尾帧收口。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { createOpenAiChatProtocol } from '../protocols/openAiChat.js';

const openAiMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openAiMocks.create } },
  })),
}));

afterEach(() => {
  vi.useRealTimers();
  openAiMocks.create.mockReset();
});

function abortableStream(
  chunks: readonly OpenAI.ChatCompletionChunk[],
  signal: AbortSignal,
): AsyncIterable<OpenAI.ChatCompletionChunk> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<OpenAI.ChatCompletionChunk>> {
          const nextChunk = chunks[index++];
          if (nextChunk) return Promise.resolve({ done: false, value: nextChunk });
          return new Promise((_, reject) => {
            const rejectAbort = (): void => {
              const error = new Error('stream aborted');
              error.name = 'AbortError';
              reject(error);
            };
            if (signal.aborted) {
              rejectAbort();
              return;
            }
            signal.addEventListener('abort', rejectAbort, { once: true });
          });
        },
      };
    },
  };
}

function chunk(input: {
  content?: string;
  finishReason?: 'stop' | 'tool_calls';
  usage?: { prompt_tokens: number; completion_tokens: number };
}): OpenAI.ChatCompletionChunk {
  return {
    id: 'chunk',
    created: 1,
    model: 'model',
    object: 'chat.completion.chunk',
    choices: input.finishReason || input.content
      ? [{ index: 0, delta: { content: input.content }, finish_reason: input.finishReason ?? null }]
      : [],
    usage: input.usage
      ? { ...input.usage, total_tokens: input.usage.prompt_tokens + input.usage.completion_tokens }
      : undefined,
  };
}

function createCall() {
  return createOpenAiChatProtocol({ providerId: 'test', apiKey: 'key' }, 'model');
}

describe('OpenAI Chat 流收口', () => {
  it('独立 ToolResult 各自投影为一条 tool 消息', async () => {
    openAiMocks.create.mockResolvedValueOnce((async function* () {
      yield chunk({ finishReason: 'stop' });
      yield chunk({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    })());
    for await (const _event of createCall()({ messages: [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'call-1', name: 'Read', args: {} },
        { type: 'tool_use', id: 'call-2', name: 'Glob', args: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'call-1', content: 'first' }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'call-2', content: 'second' }] },
    ] })) {
      // 消费请求流, 再检查传给 SDK 的消息形状.
    }

    expect(openAiMocks.create.mock.calls[0]![0].messages.slice(-2)).toEqual([
      { role: 'tool', tool_call_id: 'call-1', content: 'first' },
      { role: 'tool', tool_call_id: 'call-2', content: 'second' },
    ]);
  });

  it('流输出正文后卡在下一帧时，用户 AbortSignal 会立即终止消费', async () => {
    openAiMocks.create.mockImplementation(async (_params, options: { signal: AbortSignal }) =>
      abortableStream([chunk({ content: '已输出正文' })], options.signal));
    const controller = new AbortController();
    const stream = createCall()({
      messages: [{ role: 'user', content: 'hello' }],
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'text_delta', delta: '已输出正文' },
    });
    const pending = stream.next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('没有任何新帧时按流空闲超时报告不完整流', async () => {
    vi.useFakeTimers();
    openAiMocks.create.mockImplementation(async (_params, options: { signal: AbortSignal }) =>
      abortableStream([], options.signal));
    const pending = createCall()({
      messages: [{ role: 'user', content: 'hello' }],
    })[Symbol.asyncIterator]().next();
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'LlmStreamProtocolError',
      code: 'provider/incomplete_stream',
    });

    await vi.advanceTimersByTimeAsync(60_000);

    await rejected;
  });

  it('收到 finish_reason 后 Usage 尾帧缺失不会永久等待', async () => {
    vi.useFakeTimers();
    openAiMocks.create.mockImplementation(async (_params, options: { signal: AbortSignal }) =>
      abortableStream([chunk({ finishReason: 'stop' })], options.signal));
    const pending = createCall()({
      messages: [{ role: 'user', content: 'hello' }],
    })[Symbol.asyncIterator]().next();

    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toEqual({
      done: false,
      value: { type: 'done', stopReason: 'end_turn' },
    });
  });

  it('finish_reason 后到达的 Usage 尾帧仍会被记录再结束', async () => {
    openAiMocks.create.mockImplementation(async (_params, options: { signal: AbortSignal }) =>
      abortableStream([
        chunk({ finishReason: 'stop' }),
        chunk({ usage: { prompt_tokens: 100, completion_tokens: 20 } }),
      ], options.signal));
    const events = [];

    for await (const event of createCall()({ messages: [{ role: 'user', content: 'hello' }] })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ type: 'usage', inputTokens: 100, outputTokens: 20 }),
      { type: 'done', stopReason: 'end_turn' },
    ]);
  });

  it('tool_calls 终态只完成一次已经缓冲的 Tool Call', async () => {
    const toolChunk = chunk({ finishReason: 'tool_calls' });
    toolChunk.choices[0]!.delta.tool_calls = [{
      index: 0,
      id: 'call-1',
      type: 'function',
      function: { name: 'Read', arguments: '{"path":"a.ts"}' },
    }];
    openAiMocks.create.mockImplementation(async (_params, options: { signal: AbortSignal }) =>
      abortableStream([
        toolChunk,
        chunk({ usage: { prompt_tokens: 20, completion_tokens: 5 } }),
      ], options.signal));
    const events = [];

    for await (const event of createCall()({ messages: [{ role: 'user', content: 'read' }] })) {
      events.push(event);
    }

    expect(events.filter(event => event.type === 'tool_use_complete')).toEqual([{
      type: 'tool_use_complete',
      blockIndex: 0,
      callId: 'call-1',
      name: 'Read',
      args: { path: 'a.ts' },
    }]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });
});
