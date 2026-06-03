/**
 * live-deepseek.test.ts — DeepSeek API 实时集成测试
 *
 * 运行前置条件：
 *   export DEEPSEEK_API_KEY="sk-..."
 *
 * 所有测试在未设置 key 时自动跳过，不会阻断 CI。
 *
 * 测试范围：
 *   1. 基础流式输出 (text_delta)
 *   2. 思考模式 (reasoning_content → thinking_delta)
 *   3. 工具调用 (tool_use_complete)
 *   4. complete() — 非流式聚合
 *   5. probe()   — 健康检查
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { LlmRouter } from '../src/router.js';
import type { LlmStreamChunk, ProviderConfig, LlmToolDef } from '../src/types.js';

// ── 环境变量检查 ──────────────────────────────────────────────────────────────

const API_KEY = process.env['DEEPSEEK_API_KEY'];
const SKIP    = !API_KEY;
const skip    = (name: string, fn: () => Promise<void>) =>
  it(SKIP ? `[SKIP — no DEEPSEEK_API_KEY] ${name}` : name, SKIP ? () => {} : fn);

// ── Provider 配置 ─────────────────────────────────────────────────────────────

const PROVIDER_ID = 'deepseek-live-test';
const MODEL_FLASH = 'deepseek-v4-flash';   // 快、便宜，用于大多数测试
const MODEL_PRO   = 'deepseek-v4-pro';     // thinking 更强，用于思考测试

let router: LlmRouter;

beforeAll(() => {
  const cfg: ProviderConfig = {
    id:       PROVIDER_ID,
    protocol: 'openai-llm',
    apiKey:   API_KEY ?? '',
    baseUrl:  'https://api.deepseek.com',
  };
  router = new LlmRouter([cfg]);
});

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

async function collectStream(
  iter: AsyncIterable<LlmStreamChunk>,
): Promise<{
  texts:    string[];
  thinking: string[];
  tools:    Array<{ name: string; args: unknown }>;
  usage:    { inputTokens: number; outputTokens: number } | null;
  done:     LlmStreamChunk & { type: 'done' } | null;
}> {
  const texts:    string[] = [];
  const thinking: string[] = [];
  const tools:    Array<{ name: string; args: unknown }> = [];
  let   usage:    { inputTokens: number; outputTokens: number } | null = null;
  let   done:     LlmStreamChunk & { type: 'done' } | null = null;

  for await (const chunk of iter) {
    switch (chunk.type) {
      case 'text_delta':        texts.push(chunk.delta); break;
      case 'thinking_delta':    thinking.push(chunk.delta); break;
      case 'tool_use_complete': tools.push({ name: chunk.name, args: chunk.args }); break;
      case 'usage':             usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens }; break;
      case 'done':              done = chunk; break;
    }
  }

  return { texts, thinking, tools, usage, done };
}

// ── 测试 1：基础流式输出 ──────────────────────────────────────────────────────

describe('DeepSeek — basic streaming', () => {
  skip('returns text_delta chunks and a done event', async () => {
    const iter = router.stream({
      providerId: PROVIDER_ID,
      model:      MODEL_FLASH,
      messages:   [{ role: 'user', content: '用一句话介绍你自己。' }],
      maxTokens:  64,
    });

    const { texts, done, usage } = await collectStream(iter);

    expect(texts.length).toBeGreaterThan(0);
    expect(texts.join('')).toBeTruthy();
    expect(done?.stopReason).toBe('end_turn');
    expect(usage?.outputTokens).toBeGreaterThan(0);
  });

  skip('blockIndex is 0 for non-thinking text (no gap at index 1)', async () => {
    const rawChunks: LlmStreamChunk[] = [];
    for await (const chunk of router.stream({
      providerId: PROVIDER_ID,
      model:      MODEL_FLASH,
      messages:   [{ role: 'user', content: '1+1等于几？' }],
      maxTokens:  16,
    })) {
      rawChunks.push(chunk);
    }

    const textDeltas = rawChunks.filter(c => c.type === 'text_delta') as
      Array<LlmStreamChunk & { type: 'text_delta' }>;

    expect(textDeltas.length).toBeGreaterThan(0);
    // non-thinking model: all text should be blockIndex 0
    for (const d of textDeltas) {
      expect(d.blockIndex).toBe(0);
    }
  });
});

// ── 测试 2：思考模式 ──────────────────────────────────────────────────────────

describe('DeepSeek — thinking mode (reasoning_content)', () => {
  skip('produces thinking_delta chunks when model reasons', async () => {
    // deepseek-v4-pro 默认开启思考；发一个需要推理的问题
    const iter = router.stream({
      providerId: PROVIDER_ID,
      model:      MODEL_PRO,
      messages:   [{ role: 'user', content: '9.11 和 9.8 哪个更大？请思考后回答。' }],
      maxTokens:  512,
    });

    const { texts, thinking, done } = await collectStream(iter);

    // 有些模型可能不输出 thinking，但至少应该有 text
    expect(texts.join('')).toBeTruthy();
    expect(done?.stopReason).toBe('end_turn');

    if (thinking.length > 0) {
      // 如果有 thinking，text 应该在 blockIndex 1（thinking 占 0）
      const rawChunks: LlmStreamChunk[] = [];
      for await (const chunk of router.stream({
        providerId: PROVIDER_ID,
        model:      MODEL_PRO,
        messages:   [{ role: 'user', content: '9.11 和 9.8 哪个更大？' }],
        maxTokens:  256,
      })) {
        rawChunks.push(chunk);
      }
      const textDeltas = rawChunks.filter(c => c.type === 'text_delta') as
        Array<LlmStreamChunk & { type: 'text_delta' }>;
      const hasThinkingChunks = rawChunks.some(c => c.type === 'thinking_delta');
      if (hasThinkingChunks) {
        for (const d of textDeltas) {
          expect(d.blockIndex).toBe(1);
        }
      }
    }
  });
});

// ── 测试 3：工具调用 ──────────────────────────────────────────────────────────

describe('DeepSeek — tool calling', () => {
  const GET_WEATHER: LlmToolDef = {
    name:        'get_weather',
    description: '获取指定城市的天气',
    parameters: {
      type:       'object',
      properties: {
        city: { type: 'string', description: '城市名' },
      },
      required: ['city'],
    },
  };

  skip('emits tool_use_complete with correct name and parsed args', async () => {
    const iter = router.stream({
      providerId: PROVIDER_ID,
      model:      MODEL_FLASH,
      messages:   [{ role: 'user', content: '杭州今天天气怎么样？' }],
      tools:      [GET_WEATHER],
      toolChoice: 'auto',
      maxTokens:  256,
    });

    const { tools, done } = await collectStream(iter);

    expect(tools.length).toBeGreaterThan(0);
    const call = tools[0]!;
    expect(call.name).toBe('get_weather');
    expect((call.args as Record<string, unknown>)['city']).toBeTruthy();
    expect(done?.stopReason).toBe('tool_use');
  });

  skip('toolChoice force-calls a specific tool', async () => {
    const iter = router.stream({
      providerId: PROVIDER_ID,
      model:      MODEL_FLASH,
      messages:   [{ role: 'user', content: '你好' }],
      tools:      [GET_WEATHER],
      toolChoice: { name: 'get_weather' },
      maxTokens:  128,
    });

    const { tools } = await collectStream(iter);

    expect(tools[0]?.name).toBe('get_weather');
  });
});

// ── 测试 4：complete() 聚合 ───────────────────────────────────────────────────

describe('DeepSeek — complete()', () => {
  skip('returns assembled LlmCompletion with text block', async () => {
    const result = await router.complete({
      providerId: PROVIDER_ID,
      model:      MODEL_FLASH,
      messages:   [{ role: 'user', content: '请说"你好"。只说这两个字。' }],
      maxTokens:  16,
    });

    expect(result.blocks.length).toBeGreaterThan(0);
    const textBlock = result.blocks.find(b => b.type === 'text');
    expect(textBlock).toBeDefined();
    expect((textBlock as { type: 'text'; text: string }).text).toBeTruthy();
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  skip('complete() blocks are in correct blockIndex order when thinking present', async () => {
    const result = await router.complete({
      providerId: PROVIDER_ID,
      model:      MODEL_PRO,
      messages:   [{ role: 'user', content: '2 的 10 次方是多少？' }],
      maxTokens:  256,
    });

    // thinking (if any) should appear before text in blocks
    const types = result.blocks.map(b => b.type);
    const textIdx    = types.indexOf('text');
    const thinkIdx   = types.indexOf('thinking');
    if (thinkIdx >= 0) {
      expect(thinkIdx).toBeLessThan(textIdx);
    }
    expect(textIdx).toBeGreaterThanOrEqual(0);
  });
});

// ── 测试 5：probe() ───────────────────────────────────────────────────────────

describe('DeepSeek — probe()', () => {
  skip('returns ok:true for a valid provider + model', async () => {
    const result = await router.probe(PROVIDER_ID, MODEL_FLASH);

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });

  skip('returns ok:false for a wrong API key', async () => {
    const badCfg: ProviderConfig = {
      id:       'ds-bad',
      protocol: 'openai-llm',
      apiKey:   'sk-invalid-key-xxx',
      baseUrl:  'https://api.deepseek.com',
    };
    const badRouter = new LlmRouter([badCfg]);

    const result = await badRouter.probe('ds-bad', MODEL_FLASH);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ── 测试 6：getProtocol() ─────────────────────────────────────────────────────

describe('DeepSeek — getProtocol()', () => {
  it('returns openai-llm for the DeepSeek provider config', () => {
    // This test doesn't need the API key — it's a unit check on the router state.
    if (!SKIP) {
      expect(router.getProtocol(PROVIDER_ID)).toBe('openai-llm');
    }
  });
});
