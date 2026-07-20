import { describe, expect, it, vi } from 'vitest';
import type {
  CompactionId,
  EmaStreamEvent,
  SessionId,
  TurnId,
} from '@ema-agent/contracts';
import type { Message as ModelMessage } from '@ema-agent/llm';
import { HookBus } from '@ema-agent/hook';
import { runCompaction } from '../src/compact/compactor.js';
import { DEFAULT_MEMORY_SETTINGS } from '../src/types.js';
import { DEFAULT_OVERRIDES } from '../src/maintenance/overrides.js';

const sessionId = 'session-compaction' as SessionId;
const turnId = 'turn-compaction' as TurnId;

function oversizedHistory(): ModelMessage[] {
  return Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `message-${index} ${'long context '.repeat(100)}`,
  }));
}

describe('runCompaction beforeCompact 控制协议', () => {
  it('Hook abort 后跳过 Macro LLM，并用同一个 CompactionId 关联 Hook 与 SSE', async () => {
    const hooks = new HookBus();
    const emitted: EmaStreamEvent[] = [];
    let hookCompactionId: CompactionId | undefined;

    hooks.register('beforeCompact', (ctx) => {
      hookCompactionId = ctx.payload.compactionId;
      return { kind: 'abort', reason: '用户关闭了本次自动压缩' };
    }, { name: 'test:compaction-policy' });

    const llmStream = vi.fn();
    const result = await runCompaction(
      { hookBus: hooks, llm: { stream: llmStream } } as never,
      {
        ...DEFAULT_MEMORY_SETTINGS,
        compaction: { bufferTokens: 0 },
      },
      () => DEFAULT_OVERRIDES,
      {
        sessionId,
        turnId,
        mode: 'agent',
        messages: oversizedHistory(),
        modelContextWindow: 1,
        providerId: 'provider-1',
        model: 'model-1',
        emit: (event) => emitted.push(event),
      },
    );

    expect(result).toEqual(expect.objectContaining({
      status: 'skipped',
      reason: 'hook_aborted',
      detail: '用户关闭了本次自动压缩',
      macroRan: false,
    }));
    expect(llmStream).not.toHaveBeenCalled();
    expect(hookCompactionId).toEqual(expect.any(String));
    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'memory_compaction_skipped',
        compactionId: hookCompactionId,
        sessionId,
        turnId,
        reason: 'hook_aborted',
        message: '用户关闭了本次自动压缩',
      }),
    ]);
  });
});
