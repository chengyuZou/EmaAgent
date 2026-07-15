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

  it('V1 默认不注册 Artifact 工具(enableArtifacts 缺省)', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const names = registry.descriptors().map((tool) => tool.name);
    expect(names).not.toContain('artifact_write');
    expect(names).not.toContain('artifact_read');
    expect(names).not.toContain('artifact_list');
  });

  it('enableArtifacts:false 显式关闭时不注册 Artifact 工具', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, { enableArtifacts: false });

    const names = registry.descriptors().map((tool) => tool.name);
    expect(names).not.toContain('artifact_write');
    expect(names).not.toContain('artifact_list');
  });

  it('enableArtifacts:true 时注册全部 3 个 Artifact 工具', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, { enableArtifacts: true });

    const names = registry.descriptors().map((tool) => tool.name);
    expect(names).toContain('artifact_write');
    expect(names).toContain('artifact_read');
    expect(names).toContain('artifact_list');
  });
});
