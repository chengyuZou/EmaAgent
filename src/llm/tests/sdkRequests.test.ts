import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createLLMCall, createLLMCompletion } from '../languageModel.js';
import type { LLMProtocol, LLMRequest } from '../types.js';

interface CapturedRequest {
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

interface ProtocolCase {
  readonly protocol: LLMProtocol;
  readonly endpoint: string;
  readonly events: readonly { readonly event?: string; readonly data: unknown }[];
  readonly completionEndpoint: string;
  readonly completion: unknown;
}

const cases: readonly ProtocolCase[] = [
  {
    protocol: 'openai-llm',
    endpoint: '/v1/chat/completions',
    completionEndpoint: '/v1/chat/completions',
    completion: {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    },
    events: [
      { data: { choices: [{ delta: { content: 'ok' }, finish_reason: null }] } },
      { data: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
      { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } } },
    ],
  },
  {
    protocol: 'openai-responses-llm',
    endpoint: '/v1/responses',
    completionEndpoint: '/v1/responses',
    completion: {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
      usage: { input_tokens: 3, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
    },
    events: [
      {
        data: {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'message-1',
          delta: 'ok',
        },
      },
      {
        data: {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 3,
              output_tokens: 1,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        },
      },
    ],
  },
  {
    protocol: 'anthropic-llm',
    endpoint: '/v1/messages',
    completionEndpoint: '/v1/messages',
    completion: {
      id: 'message-1',
      type: 'message',
      role: 'assistant',
      model: 'model',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    },
    events: [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'message-1',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'model',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'ok' },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ],
  },
  {
    protocol: 'gemini-llm',
    endpoint: '/v1beta/models/model:streamGenerateContent?alt=sse',
    completionEndpoint: '/v1beta/models/model:generateContent',
    completion: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
    },
    events: [{
      data: {
        candidates: [{
          content: { role: 'model', parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
      },
    }],
  },
];

async function withServer(
  respond: (response: http.ServerResponse) => void,
  run: (baseUrl: string, requests: readonly CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ url: request.url ?? '', headers: request.headers, body });
      respond(response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => {
      if (error) reject(error);
      else resolve();
    }));
  }
}

function callFor(protocol: LLMProtocol, baseUrl: string) {
  return createLLMCall({
    providerId: 'local-test',
    protocol,
    baseUrl: protocol.startsWith('openai') ? `${baseUrl}/v1` : baseUrl,
    apiKey: 'local-test-key',
  }, 'model');
}

function completeFor(protocol: LLMProtocol, baseUrl: string) {
  return createLLMCompletion({
    providerId: 'local-test',
    protocol,
    baseUrl: protocol.startsWith('openai') ? `${baseUrl}/v1` : baseUrl,
    apiKey: 'local-test-key',
  }, 'model');
}

async function readEvents(protocol: LLMProtocol, baseUrl: string, input: LLMRequest) {
  const events = [];
  for await (const event of callFor(protocol, baseUrl)(input)) events.push(event);
  return events;
}

const request: LLMRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  maxOutputTokens: 128,
};

describe('真实 SDK 的本地 HTTP 请求', () => {
  it.each(cases)('$protocol 流式入口只发一次流式请求', async testCase => {
    await withServer(response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of testCase.events) {
        if (event.event) response.write(`event: ${event.event}\n`);
        response.write(`data: ${JSON.stringify(event.data)}\n\n`);
      }
      response.end();
    }, async (baseUrl, requests) => {
      const events = await readEvents(testCase.protocol, baseUrl, {
        ...request,
        signal: AbortSignal.timeout(4_000),
      });
      expect(events).toContainEqual({ type: 'text_delta', blockIndex: 0, delta: 'ok' });
      expect(events).toContainEqual({ type: 'done', stopReason: 'end_turn' });
      expect(events).toContainEqual(expect.objectContaining({ type: 'usage', inputTokens: 3, outputTokens: 1 }));
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(testCase.endpoint);
      const body = JSON.parse(requests[0]!.body) as {
        model?: string;
        stream?: boolean;
        messages?: unknown[];
        input?: unknown[];
        contents?: unknown[];
      };
      if (testCase.protocol === 'gemini-llm') {
        expect(body.contents).toHaveLength(1);
        expect(requests[0]?.headers['x-goog-api-key']).toBe('local-test-key');
      } else {
        expect(body.model).toBe('model');
        expect(body.stream).toBe(true);
        if (testCase.protocol === 'anthropic-llm') {
          expect(requests[0]?.headers['x-api-key']).toBe('local-test-key');
        } else {
          expect(requests[0]?.headers.authorization).toBe('Bearer local-test-key');
        }
      }
    });
  });

  it.each(cases)('$protocol 最终结果入口只发一次非流式请求', async testCase => {
    await withServer(response => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(testCase.completion));
    }, async (baseUrl, requests) => {
      const result = await completeFor(testCase.protocol, baseUrl)({
        ...request,
        signal: AbortSignal.timeout(4_000),
      });
      expect(result.blocks).toEqual([{ type: 'text', text: 'ok' }]);
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 1 });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(testCase.completionEndpoint);
      const body = JSON.parse(requests[0]!.body) as { stream?: boolean; stream_options?: unknown };
      if (testCase.protocol !== 'gemini-llm') expect(body.stream).toBe(false);
      expect(body.stream_options).toBeUndefined();
    });
  });

  it.each(cases)('$protocol 收到 429 后不在 SDK 内重试', async testCase => {
    await withServer(response => {
      response.writeHead(429, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          message: 'rate limited',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      }));
    }, async (baseUrl, requests) => {
      await expect(completeFor(testCase.protocol, baseUrl)({
        ...request,
        signal: AbortSignal.timeout(4_000),
      })).rejects.toMatchObject({ status: 429 });
      expect(requests).toHaveLength(1);
    });
  });

  it.each(cases)('$protocol 流式入口收到 429 后不在 SDK 内重试', async testCase => {
    await withServer(response => {
      response.writeHead(429, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }));
    }, async (baseUrl, requests) => {
      await expect(readEvents(testCase.protocol, baseUrl, {
        ...request,
        signal: AbortSignal.timeout(4_000),
      })).rejects.toMatchObject({ status: 429 });
      expect(requests).toHaveLength(1);
    });
  });

  it.each(cases)('$protocol 非流式请求等待响应时取消, 原样拒绝且不补发请求', async testCase => {
    const controller = new AbortController();
    const reason = new Error('cancel local completion request');
    await withServer(() => {
      controller.abort(reason);
    }, async (baseUrl, requests) => {
      await expect(completeFor(testCase.protocol, baseUrl)({ ...request, signal: controller.signal }))
        .rejects.toBe(reason);
      expect(requests).toHaveLength(1);
    });
  });

  it('流式请求取消会原样拒绝, 不补发请求', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel local SDK request');
    await withServer(response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      controller.abort(reason);
    }, async (baseUrl, requests) => {
      await expect(readEvents('openai-llm', baseUrl, {
        ...request,
        signal: controller.signal,
      })).rejects.toBe(reason);
      expect(requests).toHaveLength(1);
    });
  });
});
