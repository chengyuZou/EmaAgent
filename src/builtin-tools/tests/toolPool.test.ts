import { describe, expect, it } from 'vitest';
import type { ToolPermissionContext } from '@ema-agent/permission';
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

  it('问询工具固定走 ask(它自己就是询问通道, 不由规则绕过)', async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const registered = registry.get(BuiltinTools.AskUser.name);
    expect(registered).toBeDefined();
    const permissionContext: ToolPermissionContext = {
      mode: 'default',
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    };
    await expect(
      registered!.checkPermissions({}, {} as never, permissionContext),
    ).resolves.toMatchObject({ behavior: 'ask' });
  });
});
