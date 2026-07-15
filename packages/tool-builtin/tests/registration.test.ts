import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@ema-agent/tools';
import { registerBuiltinTools } from '../src/index.js';

describe('V1 内置工具注册边界', () => {
  it('未完成的 Plan Mode 工具不向模型暴露', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const names = registry.descriptors().map((tool) => tool.name);
    expect(names).not.toContain('plan_enter');
    expect(names).not.toContain('plan_exit');
  });
});
