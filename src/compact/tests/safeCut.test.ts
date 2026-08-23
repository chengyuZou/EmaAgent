// 测试近期尾部 Token 裁切：按预算从尾部累计、最新一条永远保留、Tool 配对不拆散。
import { describe, expect, it } from 'vitest';
import type { Message } from '@ema-agent/llm';
import { findRetainedHistoryStart } from '../safeCut.js';

// 400 ASCII 字符 ≈ 100 token + 10 信封 = 110/条（估算启发式确定性足够）。
const user = (chars = 400): Message => ({ role: 'user', content: 'x'.repeat(chars) });

describe('findRetainedHistoryStart', () => {
  it('尾部总量达到预算即停', () => {
    const history = Array.from({ length: 10 }, () => user());
    // 每条 110：330 预算恰好装 3 条。
    expect(findRetainedHistoryStart(history, 330)).toBe(7);
  });

  it('预算小于单条也永远保留最新一条', () => {
    expect(findRetainedHistoryStart([user(), user()], 5)).toBe(1);
  });

  it('预算覆盖全部历史时返回 0', () => {
    expect(findRetainedHistoryStart([user(), user()], 100_000)).toBe(0);
  });

  it('裸切点拆散 Tool 配对时向前扩展到配对完整', () => {
    const history: Message[] = [
      user(),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'Read', args: { payload: 'x'.repeat(4_000) } }],
      },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'ok' }] },
      user(),
    ];
    // 预算只够最新一条 user：无配对问题，切点就是 3。
    expect(findRetainedHistoryStart(history, 110)).toBe(3);
    // 预算装得下 [tool_result, 最新 user] 但装不下巨大的 tool_use：裸切点 2 会把
    // tool_result 留在尾部而调用进摘要，向前扩展到 1 保住配对。
    expect(findRetainedHistoryStart(history, 200)).toBe(1);
  });
});
