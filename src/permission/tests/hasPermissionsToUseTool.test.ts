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
    isBypassPermissionsModeAvailable: false,
    sessionId: 's1',
    toolCallId: 'c1',
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

  it('整体 ask 规则先于 Tool 自检', async () => {
    const context = makeContext({ alwaysAskRules: { userSettings: ['Bash'] } });
    const tool = makeTool(ALLOW);
    const decision = await hasPermissionsToUseTool(tool, {}, {}, context, { interactive: true });
    expect(decision.behavior).toBe('ask');
    expect(tool.checkPermissions).not.toHaveBeenCalled();
  });

  it('Tool deny / ask 先于 bypassPermissions', async () => {
    const context = makeContext({
      mode: 'bypassPermissions',
      isBypassPermissionsModeAvailable: true,
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

  it('bypass 可用时放行；正式构建禁用时拒绝', async () => {
    const available = await hasPermissionsToUseTool(
      makeTool(PASS), {}, {},
      makeContext({ mode: 'bypassPermissions', isBypassPermissionsModeAvailable: true }),
      { interactive: true },
    );
    expect(available).toMatchObject({ behavior: 'allow', decisionReason: { type: 'mode', mode: 'bypassPermissions' } });

    const disabled = await hasPermissionsToUseTool(
      makeTool(PASS), {}, {},
      makeContext({ mode: 'bypassPermissions', isBypassPermissionsModeAvailable: false }),
      { interactive: true },
    );
    expect(disabled.behavior).toBe('deny');
  });

  it('整体 allow 规则先于 Tool 自我放行；session 源最先命中', async () => {
    const context = makeContext({
      alwaysAllowRules: {
        userSettings: ['Bash'],
        session: ['Bash'],
      },
    });
    const decision = await hasPermissionsToUseTool(makeTool(PASS), {}, {}, context, { interactive: true });
    expect(decision).toMatchObject({
      behavior: 'allow',
      decisionReason: { type: 'rule', rule: { source: 'session' } },
    });
  });

  it('passthrough 收口为 ask；无交互通道时 ask 变 deny(headless)', async () => {
    const interactive = await hasPermissionsToUseTool(makeTool(PASS), {}, {}, makeContext(), { interactive: true });
    expect(interactive.behavior).toBe('ask');

    const headless = await hasPermissionsToUseTool(makeTool(PASS), {}, {}, makeContext(), { interactive: false });
    expect(headless).toMatchObject({ behavior: 'deny', decisionReason: { type: 'headless' } });
  });
});
