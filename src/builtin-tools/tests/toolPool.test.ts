import { describe, expect, it } from 'vitest';
import { checkToolPermission, type PermissionContext } from '@ema-agent/permission';
import {
  assembleToolPool,
  ToolRegistry,
  type ToolUseContext,
} from '@ema-agent/tools';
import { BuiltinTools, registerBuiltinTools } from '../index.js';

describe('Builtin ToolPool', () => {
  it('工具列表不依赖执行环境, 缺少能力由实际调用前检查', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const pool = assembleToolPool(registry);
    const context: ToolUseContext = { cwd: '', platform: process.platform };

    for (const identity of [
      BuiltinTools.FileRead, BuiltinTools.AskUser, BuiltinTools.Subagent,
      BuiltinTools.NarrativeSearch, BuiltinTools.DescribeImage,
    ]) {
      const tool = pool.get(identity.name);
      expect(tool).toBeDefined();
      expect(tool!.validateContext(context).valid).toBe(false);
    }
    expect(pool.get(BuiltinTools.WebSearch.name)).toBeDefined();
  });

  it('AskUser 默认允许执行, 实际问题由工具展示, 不多问一次权限', async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const registered = registry.get(BuiltinTools.AskUser.name);
    expect(registered).toBeDefined();
    const permissionContext: PermissionContext = {
      mode: 'default',
      sessionId: 'permission-test', rules: [], workspaceRoots: [],
    };
    await expect(
      checkToolPermission(registered!, {}, {} as never, permissionContext, { interactive: true }),
    ).resolves.toMatchObject({ decision: 'allow' });
  });
});
