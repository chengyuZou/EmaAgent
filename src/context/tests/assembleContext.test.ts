// 验证 Context 的固定顺序、缓存切口和分类总量；压缩由 Compact 单独测试。
import { describe, expect, it } from 'vitest';
import { PROMPT_DYNAMIC_BOUNDARY } from '@ema-agent/prompts';
import { ToolPool } from '@ema-agent/tools';
import { assembleContext } from '../assembleContext.js';
import { ContextAssemblyError } from '../errors.js';

function input(overrides: Record<string, unknown> = {}) {
  return {
    executionProfile: 'work' as const,
    systemPrompt: [
      '# 产品规则\n稳定内容',
      PROMPT_DYNAMIC_BOUNDARY,
      '# 当前角色\n动态内容',
    ],
    toolPool: new ToolPool([]),
    history: [{ role: 'user' as const, content: '历史消息' }],
    currentTurn: [{ role: 'user' as const, content: '当前输入' }],
    reminder: {
      currentDate: '2026-08-09',
      memoryRecall: '用户喜欢红茶',
    },
    contextWindow: 100_000,
    ...overrides,
  };
}

describe('assembleContext', () => {
  it('剥离 Prompt 哨兵并把动态提醒放在历史和当前输入之间', () => {
    const result = assembleContext(input());

    expect(result.messages.map((message) => message.content)).toEqual([
      '# 产品规则\n稳定内容',
      '# 当前角色\n动态内容',
      '历史消息',
      expect.stringContaining('<system-reminder>'),
      '当前输入',
    ]);
    expect(result.messages[0]).toMatchObject({ cacheBreakpoint: true });
    expect(result.messages.at(-1)).toMatchObject({ cacheBreakpoint: true });
    expect(JSON.stringify(result.messages)).not.toContain(PROMPT_DYNAMIC_BOUNDARY);
    expect(result.usage.categories.reduce((sum, category) => sum + category.tokens, 0))
      .toBe(result.usage.estimatedInputTokens);
  });

  it('只在 Work 模式投影 Git 摘要，且清除历史遗留的请求级缓存断点', () => {
    const gitSummary = {
      capability: 'ok' as const,
      repoRoot: 'D:/Github/EmaAgent',
      branch: 'main',
      headShortSha: null,
      unstaged: { filesChanged: 2, insertions: 10, deletions: 3 },
      staged: { filesChanged: 1, insertions: 4, deletions: 0 },
      untrackedCount: 1,
      upstream: 'origin/main',
      originUrl: 'https://secret@example.com/repo.git',
    };

    const work = assembleContext(input({
      history: [{ role: 'user', content: '历史消息', cacheBreakpoint: true }],
      reminder: { currentDate: '2026-08-09', gitSummary },
    }));
    expect(JSON.stringify(work.messages)).toContain('分支：main');
    expect(JSON.stringify(work.messages)).not.toContain('secret@example.com');
    expect(work.messages[2]).not.toHaveProperty('cacheBreakpoint');
    expect(work.messages.filter((message) => message.cacheBreakpoint)).toHaveLength(2);

    const chat = assembleContext(input({
      executionProfile: 'chat',
      reminder: { currentDate: '2026-08-09', gitSummary },
    }));
    expect(JSON.stringify(chat.messages)).not.toContain('分支：main');
  });

  it('拒绝把 system message 混进历史', () => {
    try {
      assembleContext(input({
        history: [{ role: 'system', content: '不应持久化的旧系统消息' }],
      }));
      throw new Error('预期 ContextAssemblyError');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextAssemblyError);
      expect(error).toMatchObject({
        code: 'context/system-message-outside-prompt',
      });
    }
  });
});
