// 测试中央判定的固定优先级：整体规则 → Tool 自检 → bypass → allow 规则 → passthrough。
import { describe, expect, it, vi } from 'vitest';
import {
  hasPermissionsToUseTool,
  type PermissionCheckableTool,
} from '../hasPermissionsToUseTool.js';
import type {
  PermissionResult,
  ToolPermissionContext,
} from '../types.js';

function makeContext(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    mode: 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    workspaceRoots: [],
    ...overrides,
  };
}

function makeTool(result: PermissionResult, name = 'Bash'): PermissionCheckableTool {
  return { name, checkPermissions: vi.fn(async () => result) };
}

const ALLOW: PermissionResult = { behavior: 'allow' };
const PASS: PermissionResult = { behavior: 'passthrough', message: 'needs review' };

describe('hasPermissionsToUseTool', () => {
  it('整体 deny 规则最先命中', async () => {
    const context = makeContext({ alwaysDenyRules: { userSettings: ['Bash'] } });
    const decision = await hasPermissionsToUseTool(makeTool(ALLOW), {}, {}, context, { interactive: true });
    expect(decision.behavior).toBe('deny');
    expect(decision.decisionReason).toMatchObject({ type: 'rule', rule: { source: 'userSettings', ruleBehavior: 'deny' } });
  });

  it('整体 ask 规则仍覆盖非 Session 的 Tool allow, Tool 自检先查 deny', async () => {
    const context = makeContext({ alwaysAskRules: { userSettings: ['Bash'] } });
    const tool = makeTool(ALLOW);
    const decision = await hasPermissionsToUseTool(tool, {}, {}, context, { interactive: true });
    expect(decision.behavior).toBe('ask');
    expect(tool.checkPermissions).toHaveBeenCalledOnce();
  });

  it('Session 批准跳过整体 ask 与 Tool ask, 但不能盖过 deny', async () => {
    const context = makeContext({
      alwaysAllowRules: { session: ['Bash(input:{})'] },
      alwaysAskRules: { userSettings: ['Bash'] },
    });
    expect((await hasPermissionsToUseTool(makeTool({ behavior: 'ask', message: 'safety' }),
      {}, {}, context, { interactive: true })).behavior).toBe('allow');
    expect((await hasPermissionsToUseTool(makeTool({ behavior: 'deny', message: 'blocked' }),
      {}, {}, context, { interactive: true })).behavior).toBe('deny');
    expect((await hasPermissionsToUseTool(makeTool(ALLOW), {}, {}, {
      ...context, alwaysDenyRules: { projectSettings: ['Bash'] },
    }, { interactive: true })).behavior).toBe('deny');
  });

  it('Tool 的匹配 Session 内容规则覆盖整体 ask, 不授予另一个工具', async () => {
    const rule = { source: 'session', ruleBehavior: 'allow', ruleValue: { toolName: 'Bash', ruleContent: 'npm test' } } as const;
    expect((await hasPermissionsToUseTool(makeTool({ behavior: 'allow', decisionReason: { type: 'rule', rule } }),
      {}, {}, makeContext({ alwaysAskRules: { userSettings: ['Bash'] } }), { interactive: true })).behavior).toBe('allow');
    expect((await hasPermissionsToUseTool(makeTool(PASS, 'mcp__server__other'), {}, {},
      makeContext({ alwaysAllowRules: { session: ['mcp__server__one'] } }), { interactive: true })).behavior).toBe('ask');
  });

  it('Tool deny / ask 先于 bypassPermissions', async () => {
    const context = makeContext({
      mode: 'bypassPermissions',
    });
    const denying = await hasPermissionsToUseTool(
      makeTool({ behavior: 'deny', message: 'no' }), {}, {}, context, { interactive: true },
    );
    expect(denying.behavior).toBe('deny');
    const asking = await hasPermissionsToUseTool(
      makeTool({ behavior: 'ask', message: 'confirm' }), {}, {}, context, { interactive: true },
    );
    expect(asking.behavior).toBe('ask');
  });

  it('bypass 对 passthrough Tool 放行', async () => {
    const available = await hasPermissionsToUseTool(
      makeTool(PASS), {}, {},
      makeContext({ mode: 'bypassPermissions' }),
      { interactive: true },
    );
    expect(available).toMatchObject({ behavior: 'allow', decisionReason: { type: 'mode', mode: 'bypassPermissions' } });

  });

  it('整体配置 allow 规则先于 Tool 自我放行', async () => {
    const context = makeContext({
      alwaysAllowRules: {
        userSettings: ['Bash'],
      },
    });
    const decision = await hasPermissionsToUseTool(makeTool(PASS), {}, {}, context, { interactive: true });
    expect(decision).toMatchObject({
      behavior: 'allow',
      decisionReason: { type: 'rule', rule: { source: 'userSettings' } },
    });
  });

  it('passthrough 收口为 ask；无交互通道时 ask 变 deny(headless)', async () => {
    const interactive = await hasPermissionsToUseTool(makeTool(PASS), {}, {}, makeContext(), { interactive: true });
    expect(interactive.behavior).toBe('ask');

    const headless = await hasPermissionsToUseTool(makeTool(PASS), {}, {}, makeContext(), { interactive: false });
    expect(headless).toMatchObject({ behavior: 'deny', decisionReason: { type: 'headless' } });
  });

  it('默认精确输入规则忽略对象键顺序, 保留嵌套值与数组顺序', async () => {
    const tool = makeTool(PASS, 'mcp__server__action');
    const first = await hasPermissionsToUseTool(tool, {
      list: [1, 2], target: { z: 'x', a: true },
    }, {}, makeContext(), { interactive: true });
    expect(first.behavior).toBe('ask');
    if (first.behavior !== 'ask') throw new Error('expected ask');
    expect(first.sessionAllowRule).toEqual({
      toolName: tool.name,
      ruleContent: 'input:{"list":[1,2],"target":{"a":true,"z":"x"}}',
    });
    const context = makeContext({ alwaysAllowRules: {
      session: [`${tool.name}(${first.sessionAllowRule.ruleContent})`],
    } });
    expect((await hasPermissionsToUseTool(tool, {
      target: { a: true, z: 'x' }, list: [1, 2],
    }, {}, context, { interactive: true })).behavior).toBe('allow');
    expect((await hasPermissionsToUseTool(tool, {
      list: [2, 1], target: { a: true, z: 'x' },
    }, {}, context, { interactive: true })).behavior).toBe('ask');
    expect((await hasPermissionsToUseTool(tool, {
      list: [1, 2], target: { a: true, z: 'other' },
    }, {}, context, { interactive: true })).behavior).toBe('ask');
  });

  it.each(['allow', 'passthrough', 'ask'] as const)('中央询问保留 Tool %s 的专门范围', async behavior => {
    const sessionAllowRule = { toolName: 'Read', ruleContent: 'file:/outside/a.ts' };
    const tool = makeTool({ behavior, message: 'review', sessionAllowRule }, 'Read');
    const decision = await hasPermissionsToUseTool(tool, { file_path: '/outside/a.ts', offset: 20 }, {},
      makeContext({ alwaysAskRules: { userSettings: ['Read'] } }), { interactive: true });
    expect(decision).toMatchObject({ behavior: 'ask', sessionAllowRule });
  });

  it('同一个 Tool 的不同输入不共享默认会话批准', async () => {
    const context = makeContext({
      alwaysAllowRules: { session: ['ProcessStop(input:{"backgroundProcessId":"a"})'] },
      alwaysAskRules: { userSettings: ['ProcessStop'] },
    });
    const tool = makeTool({ behavior: 'ask', message: 'confirm' }, 'ProcessStop');
    expect((await hasPermissionsToUseTool(tool, { backgroundProcessId: 'a' }, {}, context,
      { interactive: true })).behavior).toBe('allow');
    expect((await hasPermissionsToUseTool(tool, { backgroundProcessId: 'b' }, {}, context,
      { interactive: true })).behavior).toBe('ask');
  });
});
