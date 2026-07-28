// 测试 Chat/Work 在每根 Turn 中使用冻结的 Agent 迭代上限。

import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_SETTINGS } from '@ema-agent/agent';
import { executionProfilePolicy } from '../executionProfilePolicy.js';

describe('executionProfilePolicy', () => {
  it('分别读取 Chat 与 Work 的当前 Turn 设置', () => {
    const settings = {
      ...DEFAULT_AGENT_SETTINGS,
      chatMaxIterations: 5,
      workMaxIterations: 47,
    };

    expect(executionProfilePolicy('chat', settings).maxIterations).toBe(5);
    expect(executionProfilePolicy('work', settings).maxIterations).toBe(47);
  });
});
