/**
 * DeepSeek live protocol comparison.
 *
 * This file is intentionally excluded from the default Vitest run. Execute it
 * explicitly with DEEPSEEK_API_KEY when validating DeepSeek's OpenAI-compatible
 * and Anthropic-compatible endpoints.
 */

import { describe, expect, it } from 'vitest';
import { LanguageModelRuntime } from '../languageModelRuntime.js';
import type { AssistantBlock, LlmMessage, LlmStreamChunk, LlmToolDef, ProviderConfig } from '../types.js';

const API_KEY = process.env['DEEPSEEK_API_KEY'];
const liveIt = API_KEY ? it : it.skip;

const LIVE_TIMEOUT_MS = 90_000;
const MODEL = 'deepseek-v4-flash';

const OPENAI_PROVIDER_ID = 'deepseek-openai-live';
const ANTHROPIC_PROVIDER_ID = 'deepseek-anthropic-live';

const PROVIDERS: ProviderConfig[] = [
  {
    id: OPENAI_PROVIDER_ID,
    protocol: 'openai-llm',
    apiKey: API_KEY ?? '',
    baseUrl: 'https://api.deepseek.com',
  },
  {
    id: ANTHROPIC_PROVIDER_ID,
    protocol: 'anthropic-llm',
    apiKey: API_KEY ?? '',
    baseUrl: 'https://api.deepseek.com/anthropic',
  },
];

const router = new LanguageModelRuntime(PROVIDERS);

interface ToolCompleteMetric {
  atMs: number;
  blockIndex: number;
  callIdPresent: boolean;
  name: string;
  args: unknown;
}

interface StreamMetrics {
  provider: 'openai' | 'anthropic';
  chunkCount: number;
  chunkTypes: Record<LlmStreamChunk['type'], number>;
  sequence: string[];
  textChars: number;
  thinkingChars: number;
  toolDeltaChars: number;
  toolCompletes: ToolCompleteMetric[];
  usage: { inputTokens: number; outputTokens: number } | null;
  doneStopReason: string | null;
  firstTextMs: number | null;
  firstToolDeltaMs: number | null;
  firstToolCompleteMs: number | null;
  doneMs: number | null;
}

const emptyChunkTypes = (): Record<LlmStreamChunk['type'], number> => ({
  text_delta: 0,
  thinking_delta: 0,
  thinking_complete: 0,
  tool_use_delta: 0,
  tool_use_complete: 0,
  usage: 0,
  done: 0,
});

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

async function collectMetrics(
  provider: StreamMetrics['provider'],
  iter: AsyncIterable<LlmStreamChunk>,
): Promise<StreamMetrics> {
  const start = performance.now();
  const metrics: StreamMetrics = {
    provider,
    chunkCount: 0,
    chunkTypes: emptyChunkTypes(),
    sequence: [],
    textChars: 0,
    thinkingChars: 0,
    toolDeltaChars: 0,
    toolCompletes: [],
    usage: null,
    doneStopReason: null,
    firstTextMs: null,
    firstToolDeltaMs: null,
    firstToolCompleteMs: null,
    doneMs: null,
  };

  for await (const chunk of iter) {
    const atMs = elapsedMs(start);
    metrics.chunkCount++;
    metrics.chunkTypes[chunk.type]++;

    switch (chunk.type) {
      case 'text_delta':
        metrics.sequence.push(`${chunk.type}:${chunk.blockIndex}`);
        metrics.textChars += chunk.delta.length;
        metrics.firstTextMs ??= atMs;
        break;
      case 'thinking_delta':
        metrics.sequence.push(`${chunk.type}:${chunk.blockIndex}`);
        metrics.thinkingChars += chunk.delta.length;
        break;
      case 'thinking_complete':
        metrics.sequence.push(`${chunk.type}:${chunk.blockIndex}`);
        break;
      case 'tool_use_delta':
        metrics.sequence.push(`${chunk.type}:${chunk.blockIndex}:${chunk.name || '<pending-name>'}`);
        metrics.toolDeltaChars += chunk.argsDelta.length;
        metrics.firstToolDeltaMs ??= atMs;
        break;
      case 'tool_use_complete':
        metrics.sequence.push(`${chunk.type}:${chunk.blockIndex}:${chunk.name}`);
        metrics.firstToolCompleteMs ??= atMs;
        metrics.toolCompletes.push({
          atMs,
          blockIndex: chunk.blockIndex,
          callIdPresent: chunk.callId.length > 0,
          name: chunk.name,
          args: chunk.args,
        });
        break;
      case 'usage':
        metrics.sequence.push(chunk.type);
        metrics.usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
        break;
      case 'done':
        metrics.sequence.push(`${chunk.type}:${chunk.stopReason}`);
        metrics.doneStopReason = chunk.stopReason;
        metrics.doneMs = atMs;
        break;
    }
  }

  return metrics;
}

function logMetrics(title: string, metrics: StreamMetrics): void {
  console.info(JSON.stringify({
    title,
    provider: metrics.provider,
    chunkCount: metrics.chunkCount,
    chunkTypes: metrics.chunkTypes,
    textChars: metrics.textChars,
    thinkingChars: metrics.thinkingChars,
    toolDeltaChars: metrics.toolDeltaChars,
    firstTextMs: metrics.firstTextMs,
    firstToolDeltaMs: metrics.firstToolDeltaMs,
    firstToolCompleteMs: metrics.firstToolCompleteMs,
    doneMs: metrics.doneMs,
    doneMinusFirstToolCompleteMs:
      metrics.doneMs !== null && metrics.firstToolCompleteMs !== null
        ? metrics.doneMs - metrics.firstToolCompleteMs
        : null,
    usage: metrics.usage,
    toolCompletes: metrics.toolCompletes.map(tool => ({
      atMs: tool.atMs,
      blockIndex: tool.blockIndex,
      callIdPresent: tool.callIdPresent,
      name: tool.name,
      args: tool.args,
    })),
    sequence: metrics.sequence,
  }));
}

function expectUsableTextStream(metrics: StreamMetrics): void {
  expect(metrics.doneStopReason).toBeTruthy();
  expect(metrics.chunkCount).toBeGreaterThan(1);
  expect(metrics.textChars).toBeGreaterThan(0);
}

function expectParallelToolCalls(metrics: StreamMetrics): void {
  const names = new Set(metrics.toolCompletes.map(tool => tool.name));
  expect(metrics.doneStopReason).toBe('tool_use');
  expect(metrics.toolCompletes.length).toBeGreaterThanOrEqual(2);
  expect(names.has('lookup_weather')).toBe(true);
  expect(names.has('lookup_calendar')).toBe(true);
  expect(metrics.firstToolCompleteMs).not.toBeNull();
  expect(metrics.doneMs).not.toBeNull();
}

function textFromBlocks(blocks: AssistantBlock[]): string {
  return blocks
    .filter((block): block is AssistantBlock & { type: 'text' } => block.type === 'text')
    .map(block => block.text)
    .join('');
}

const TEXT_MESSAGES: LlmMessage[] = [
  {
    role: 'system',
    content: 'You are a streaming transport smoke test. Answer with concise plain text.',
  },
  {
    role: 'user',
    content: 'Reply with exactly this token followed by a short sentence: ds-stream-ok',
  },
];

const PARALLEL_TOOL_MESSAGES: LlmMessage[] = [
  {
    role: 'system',
    content:
      'You are a tool-routing test harness. When tool calls are requested, emit tool calls only and do not write explanatory text.',
  },
  {
    role: 'user',
    content:
      'Call both lookup_weather and lookup_calendar exactly once for Hangzhou on 2026-06-03. Use city="Hangzhou" and date="2026-06-03" for both calls.',
  },
];

const PARALLEL_TOOLS: LlmToolDef[] = [
  {
    name: 'lookup_weather',
    description: 'Fetch weather data for a city and date.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        city: { type: 'string' },
        date: { type: 'string' },
      },
      required: ['city', 'date'],
    },
  },
  {
    name: 'lookup_calendar',
    description: 'Fetch calendar metadata for a city and date.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        city: { type: 'string' },
        date: { type: 'string' },
      },
      required: ['city', 'date'],
    },
  },
];

describe('DeepSeek live protocol diff', () => {
  liveIt('streams text chunks through OpenAI-compatible URL', async () => {
    const metrics = await collectMetrics('openai', router.stream({
      providerId: OPENAI_PROVIDER_ID,
      model: MODEL,
      messages: TEXT_MESSAGES,
      maxTokens: 512,
    }));

    logMetrics('deepseek-openai-text-stream', metrics);
    expectUsableTextStream(metrics);
  }, LIVE_TIMEOUT_MS);

  liveIt('streams text chunks through Anthropic-compatible URL', async () => {
    const metrics = await collectMetrics('anthropic', router.stream({
      providerId: ANTHROPIC_PROVIDER_ID,
      model: MODEL,
      messages: TEXT_MESSAGES,
      maxTokens: 512,
    }));

    logMetrics('deepseek-anthropic-text-stream', metrics);
    expectUsableTextStream(metrics);
  }, LIVE_TIMEOUT_MS);

  liveIt('compares parallel tool-call yield timing between OpenAI and Anthropic URLs', async () => {
    const openai = await collectMetrics('openai', router.stream({
      providerId: OPENAI_PROVIDER_ID,
      model: MODEL,
      messages: PARALLEL_TOOL_MESSAGES,
      tools: PARALLEL_TOOLS,
      toolChoice: 'auto',
      maxTokens: 512,
    }));

    logMetrics('deepseek-openai-parallel-tools', openai);
    expectParallelToolCalls(openai);

    const anthropic = await collectMetrics('anthropic', router.stream({
      providerId: ANTHROPIC_PROVIDER_ID,
      model: MODEL,
      messages: PARALLEL_TOOL_MESSAGES,
      tools: PARALLEL_TOOLS,
      toolChoice: 'auto',
      maxTokens: 512,
    }));

    logMetrics('deepseek-anthropic-parallel-tools', anthropic);
    expectParallelToolCalls(anthropic);

    console.info(JSON.stringify({
      title: 'deepseek-tool-yield-diff',
      openaiFirstToolCompleteMs: openai.firstToolCompleteMs,
      anthropicFirstToolCompleteMs: anthropic.firstToolCompleteMs,
      openaiDoneMs: openai.doneMs,
      anthropicDoneMs: anthropic.doneMs,
      openaiDoneMinusFirstToolCompleteMs:
        openai.doneMs !== null && openai.firstToolCompleteMs !== null
          ? openai.doneMs - openai.firstToolCompleteMs
          : null,
      anthropicDoneMinusFirstToolCompleteMs:
        anthropic.doneMs !== null && anthropic.firstToolCompleteMs !== null
          ? anthropic.doneMs - anthropic.firstToolCompleteMs
          : null,
      openaiMinusAnthropicFirstToolCompleteMs:
        openai.firstToolCompleteMs !== null && anthropic.firstToolCompleteMs !== null
          ? openai.firstToolCompleteMs - anthropic.firstToolCompleteMs
          : null,
    }));
  }, LIVE_TIMEOUT_MS * 2);

  liveIt('runs a two-turn OpenAI-compatible call with previous assistant blocks', async () => {
    const firstMessages: LlmMessage[] = [
      {
        role: 'system',
        content: 'You are a deterministic multi-turn smoke test. Keep replies short.',
      },
      {
        role: 'user',
        content: 'Reply with a short sentence that contains this exact token: ds-first-turn-ok',
      },
    ];

    const first = await router.complete({
      providerId: OPENAI_PROVIDER_ID,
      model: MODEL,
      messages: firstMessages,
      thinking: { enabled: false },
      maxTokens: 128,
    });
    const firstText = textFromBlocks(first.blocks);

    expect(first.stopReason).toBe('end_turn');
    expect(firstText).toContain('ds-first-turn-ok');

    const second = await router.complete({
      providerId: OPENAI_PROVIDER_ID,
      model: MODEL,
      messages: [
        ...firstMessages,
        { role: 'assistant', content: first.blocks },
        {
          role: 'user',
          content: 'Now reply with a short sentence that contains this exact token: ds-second-turn-ok',
        },
      ],
      thinking: { enabled: false },
      maxTokens: 128,
    });
    const secondText = textFromBlocks(second.blocks);

    console.info(JSON.stringify({
      title: 'deepseek-openai-two-turn-complete',
      firstStopReason: first.stopReason,
      secondStopReason: second.stopReason,
      firstBlockTypes: first.blocks.map(block => block.type),
      secondBlockTypes: second.blocks.map(block => block.type),
      firstTextChars: firstText.length,
      secondTextChars: secondText.length,
    }));

    expect(second.stopReason).toBe('end_turn');
    expect(secondText).toContain('ds-second-turn-ok');
  }, LIVE_TIMEOUT_MS);
});
