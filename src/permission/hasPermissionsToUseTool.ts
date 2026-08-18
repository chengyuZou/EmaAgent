// 权限判定的唯一中央入口：固定优先级，Tool 自我解释，中央不解释 ruleContent 语义。
// 模式分工：default/bypassPermissions 由中央处理；acceptEdits 是 Tool 侧语义
// （"工作区内写入放行"只有文件 Tool 知道怎么判定，归各自的 checkPermissions）。
import type {
  PermissionDecision,
  PermissionResult,
  PermissionRule,
  PermissionRuleSource,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
} from './types.js';
import {
  matchesWholeTool,
  permissionRuleValueFromString,
} from './rules/permissionRuleParser.js';

/** 中央对 Tool 的最小需求：名字 + 自我解释权。 */
export interface PermissionCheckableTool {
  readonly name: string;
  checkPermissions(
    input: unknown,
    context: unknown,
    permissionContext: ToolPermissionContext,
  ): Promise<PermissionResult>;
}

export interface HasPermissionsOptions {
  /** 有交互通道（根 Turn 桌面宿主）时 ask 才弹卡；否则 ask 收口为 deny。 */
  readonly interactive: boolean;
}

/**
 * 外层：无交互通道时把 ask 收口为 deny（headless）。
 * Claude 同层另有 dontAsk/auto classifier，Ema V1 不实现。
 */
export async function hasPermissionsToUseTool(
  tool: PermissionCheckableTool,
  input: unknown,
  context: unknown,
  permissionContext: ToolPermissionContext,
  options: HasPermissionsOptions,
): Promise<PermissionDecision> {
  const inner = await hasPermissionsToUseToolInner(tool, input, context, permissionContext);
  if (inner.behavior === 'ask' && !options.interactive) {
    return {
      behavior: 'deny',
      message: inner.message,
      decisionReason: { type: 'headless' },
    };
  }
  return inner;
}

async function hasPermissionsToUseToolInner(
  tool: PermissionCheckableTool,
  input: unknown,
  context: unknown,
  permissionContext: ToolPermissionContext,
): Promise<PermissionDecision> {
  // 1. 整体 Tool deny 规则
  const denyRule = findWholeToolRule(permissionContext.alwaysDenyRules, tool.name, 'deny');
  if (denyRule) {
    return {
      behavior: 'deny',
      message: `Permission to use ${tool.name} has been denied.`,
      decisionReason: { type: 'rule', rule: denyRule },
    };
  }

  // 2. 整体 Tool ask 规则
  const askRule = findWholeToolRule(permissionContext.alwaysAskRules, tool.name, 'ask');
  if (askRule) {
    return {
      behavior: 'ask',
      message: `${tool.name} 需要用户确认`,
      decisionReason: { type: 'rule', rule: askRule },
    };
  }

  // 3. Tool 自我解释（deny / 必须交互 ask / 内容级 ask / safetyCheck 均先于 bypass）
  const toolResult = await tool.checkPermissions(input, context, permissionContext);
  if (toolResult.behavior === 'deny' || toolResult.behavior === 'ask') {
    return toolResult;
  }

  // 4. bypassPermissions（正式构建禁用；显式 deny 与 Tool ask 已在前面拦截，不是裸奔）
  if (permissionContext.mode === 'bypassPermissions') {
    if (!permissionContext.isBypassPermissionsModeAvailable) {
      return {
        behavior: 'deny',
        message: '当前构建不允许 bypassPermissions',
        decisionReason: { type: 'mode', mode: 'bypassPermissions' },
      };
    }
    return {
      behavior: 'allow',
      decisionReason: { type: 'mode', mode: 'bypassPermissions' },
    };
  }

  // 5. 整体 Tool allow 规则
  const allowRule = findWholeToolRule(permissionContext.alwaysAllowRules, tool.name, 'allow');
  if (allowRule) {
    return {
      behavior: 'allow',
      decisionReason: { type: 'rule', rule: allowRule },
    };
  }

  // 6. Tool 自我放行；passthrough 收口为 ask
  if (toolResult.behavior === 'allow') {
    return toolResult;
  }
  return {
    behavior: 'ask',
    message: toolResult.message || `${tool.name} 需要用户确认`,
    ...(toolResult.decisionReason ? { decisionReason: toolResult.decisionReason } : {}),
  };
}

/** source 优先级：session > projectSettings > userSettings（更具体的范围先生效）。 */
const SOURCE_PRECEDENCE: readonly PermissionRuleSource[] = [
  'session',
  'projectSettings',
  'userSettings',
];

function findWholeToolRule(
  rulesBySource: ToolPermissionRulesBySource,
  toolName: string,
  behavior: PermissionRule['ruleBehavior'],
): PermissionRule | undefined {
  for (const source of SOURCE_PRECEDENCE) {
    for (const ruleString of rulesBySource[source] ?? []) {
      const ruleValue = permissionRuleValueFromString(ruleString);
      if (matchesWholeTool(ruleValue, toolName)) {
        return { source, ruleBehavior: behavior, ruleValue };
      }
    }
  }
  return undefined;
}
