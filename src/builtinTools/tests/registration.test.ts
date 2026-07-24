// 测试 V1 内置工具的物理注册门禁、稳定身份和模型可见名称。
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@ema-agent/tools';
import { BuiltinTools, registerBuiltinTools } from '../index.js';

describe('V1 内置工具注册边界', () => {
  it('未完成的 Plan Mode 工具不向模型暴露', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const names = registry.descriptors().map((tool) => tool.name);
    expect(names).not.toContain(BuiltinTools.PlanEnter.name);
    expect(names).not.toContain(BuiltinTools.PlanExit.name);
  });

  it('V1 默认不注册 Artifact 工具(enableArtifacts 缺省)', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const names = registry.descriptors().map((tool) => tool.name);
    expect(names).not.toContain(BuiltinTools.ArtifactWrite.name);
    expect(names).not.toContain(BuiltinTools.ArtifactRead.name);
    expect(names).not.toContain(BuiltinTools.ArtifactList.name);
  });

  it('enableArtifacts:false 显式关闭时不注册 Artifact 工具', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, { enableArtifacts: false });

    const names = registry.descriptors().map((tool) => tool.name);
    expect(names).not.toContain(BuiltinTools.ArtifactWrite.name);
    expect(names).not.toContain(BuiltinTools.ArtifactList.name);
  });

  it('enableArtifacts:true 时注册全部 3 个 Artifact 工具', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, { enableArtifacts: true });

    const names = registry.descriptors().map((tool) => tool.name);
    expect(names).toContain(BuiltinTools.ArtifactWrite.name);
    expect(names).toContain(BuiltinTools.ArtifactRead.name);
    expect(names).toContain(BuiltinTools.ArtifactList.name);
  });

  it('业务能力工具统一注册，由每次执行的 ToolPool 决定是否可见', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const names = registry.descriptors().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      BuiltinTools.TaskCreate.name,
      BuiltinTools.TaskGet.name,
      BuiltinTools.TaskList.name,
      BuiltinTools.TaskUpdate.name,
    ]));
  });

  it('每个已注册工具都有唯一稳定 id 和 PascalCase 模型名称', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, {
      enableArtifacts: true,
    });

    const tools = registry.list();
    const ids = tools.map((tool) => tool.id);
    const names = tools.map((tool) => tool.name);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    expect(ids.every((id) => /^builtin\.[a-z0-9_.]+$/.test(id))).toBe(true);
    expect(names.every((name) => /^[A-Z][A-Za-z0-9]*$/.test(name))).toBe(true);
    expect(names.every((name) => !name.includes('_') && !name.includes('-'))).toBe(true);
  });
});
