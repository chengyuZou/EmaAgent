import type {
  PermissionBehavior,
  PermissionDecision,
  PermissionResult,
  PermissionRule,
  PermissionRuleSource,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
} from './types.js';
import { matchesWholeTool, permissionRuleValueFromString } from './rules/permissionRuleParser.js';

export interface PermissionCheckableTool {
  readonly name: string;
  checkPermissions(
    input: unknown,
    context: unknown,
    permissionContext: ToolPermissionContext,
  ): Promise<PermissionResult>;
}

export interface HasPermissionsOptions {
  /** 有宿主交互通道时 ask 才等待批准, 根与子代理共用 Session 通道; 否则 deny. */
  readonly interactive: boolean;
}

/** 输入应已通过工具校验. 没有交互通道时, 需要询问的结果转为 headless 拒绝. */
export async function hasPermissionsToUseTool(
  tool: PermissionCheckableTool,
  input: unknown,
  context: unknown,
  permissionContext: ToolPermissionContext,
  options: HasPermissionsOptions,
): Promise<PermissionDecision> {
  const inner = await hasPermissionsToUseToolInner(
    tool,
    input,
    context,
    permissionContext
  );
  if (inner.behavior === 'ask' && !options.interactive) {
    return { behavior: 'deny', message: inner.message, decisionReason: { type: 'headless' } };
  }
  return inner;
}

async function hasPermissionsToUseToolInner(
  tool: PermissionCheckableTool,
  input: unknown,
  context: unknown,
  permissionContext: ToolPermissionContext,
): Promise<PermissionDecision> {
  // 整个工具的拒绝规则先于工具自检, 会话批准和模式判断.
  const denyRule = findWholeToolRule(permissionContext.alwaysDenyRules, tool.name, 'deny');
  if (denyRule) {
    return {
      behavior: 'deny',
      message: `Permission to use ${tool.name} has been denied.`,
      decisionReason: { type: 'rule', rule: denyRule },
    };
  }

  // Tool 必须先返回显式 deny, 不能让 Session 批准掩盖内容级拒绝.
  const toolResult = await tool.checkPermissions(input, context, permissionContext);
  if (toolResult.behavior === 'deny') {
    return toolResult;
  }
  const sessionAllowRule = toolResult.sessionAllowRule ?? {
    toolName: tool.name,
    ruleContent: exactInputRuleContent(input),
  };
  if (toolResult.sessionAllowRule === undefined) {
    const sessionRule = findMatchingContentRule(
      permissionContext,
      tool.name,
      'allow',
      content => content === sessionAllowRule.ruleContent,
      'session',
    );
    if (sessionRule) {
      return { behavior: 'allow', decisionReason: { type: 'rule', rule: sessionRule } };
    }
  }
  if (toolResult.behavior === 'allow' && toolResult.decisionReason?.type === 'rule'
    && toolResult.decisionReason.rule.source === 'session') {
    return toolResult;
  }

  // Session 批准之后再检查重复询问; user/project allow 不跳过 ask.
  const askRule = findWholeToolRule(permissionContext.alwaysAskRules, tool.name, 'ask');
  if (askRule) {
    return {
      behavior: 'ask',
      message: `${tool.name} 需要用户确认`,
      decisionReason: { type: 'rule', rule: askRule },
      sessionAllowRule,
    };
  }

  if (toolResult.behavior === 'ask') {
    return { ...toolResult, sessionAllowRule };
  }

  // bypass 只放行未被明确拒绝或要求确认的调用.
  if (permissionContext.mode === 'bypassPermissions') {
    return { behavior: 'allow', decisionReason: { type: 'mode', mode: 'bypassPermissions' } };
  }

  const allowRule = findWholeToolRule(permissionContext.alwaysAllowRules, tool.name, 'allow');
  if (allowRule) {
    return { behavior: 'allow', decisionReason: { type: 'rule', rule: allowRule } };
  }

  // 没有配置或工具提供放行理由时, passthrough 仍需要用户回答.
  if (toolResult.behavior === 'allow') {
    return toolResult;
  }
  return {
    behavior: 'ask',
    message: toolResult.message || `${tool.name} 需要用户确认`,
    sessionAllowRule,
    ...(toolResult.decisionReason ? { decisionReason: toolResult.decisionReason } : {}),
  };
}

/** source 优先级:session > projectSettings > userSettings(更具体的范围先生效). */
const SOURCE_PRECEDENCE: readonly PermissionRuleSource[] = ['session', 'projectSettings', 'userSettings'];

function exactInputRuleContent(input: unknown): string {
  // 对象字段顺序不改变操作; 数组顺序和参数值保留, 不推断参数语义.
  const content = JSON.stringify(input, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
  return `input:${content}`;
}

function findWholeToolRule(
  rulesBySource: ToolPermissionRulesBySource,
  toolName: string,
  behavior: PermissionRule['ruleBehavior'],
): PermissionRule | undefined {
  for (const source of ['projectSettings', 'userSettings'] as const) {
    for (const ruleString of rulesBySource[source] ?? []) {
      const ruleValue = permissionRuleValueFromString(ruleString);
      if (matchesWholeTool(ruleValue, toolName)) {
        return { source, ruleBehavior: behavior, ruleValue };
      }
    }
  }
  return undefined;
}

/**
 * 只返回当前工具带内容的规则, 不包含整个工具的规则.
 * 同一行为内按 Session, 项目, 用户顺序查询; allow 不会覆盖其他阶段的 deny/ask.
 */
export function listContentRules(permissionContext: ToolPermissionContext, toolName: string, behavior: PermissionBehavior): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const source of SOURCE_PRECEDENCE) {
    for (const ruleString of rulesBySource(permissionContext, behavior)[source] ?? []) {
      const ruleValue = permissionRuleValueFromString(ruleString);
      if (ruleValue.ruleContent === undefined || ruleValue.toolName !== toolName) {
        continue;
      }
      rules.push({ source, ruleBehavior: behavior, ruleValue });
    }
  }
  return rules;
}

/** 单条内容规则精确命中(ruleContent 是 Tool 自转的语义串,如 WebFetch 域名). */
export function findContentRule(
  permissionContext: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
  ruleContent: string,
): PermissionRule | undefined {
  for (const rule of listContentRules(permissionContext, toolName, behavior)) {
    if (rule.ruleValue.ruleContent === ruleContent) {
      return rule;
    }
  }
  return undefined;
}

/**
 * 谓词匹配:规则内容是模式(Bash `git *`,路径 glob),Tool 传语义匹配谓词.
 * Bash 传 (c) => matchShellRule(c, command);文件 Tool 传 (c) => matchPathRule(c, path, root).
 */
export function findMatchingContentRule(
  permissionContext: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
  matches: (ruleContent: string) => boolean,
  source?: PermissionRuleSource,
): PermissionRule | undefined {
  for (const rule of listContentRules(permissionContext, toolName, behavior)) {
    if (source !== undefined && rule.source !== source) {
      continue;
    }
    if (matches(rule.ruleValue.ruleContent!)) {
      return rule;
    }
  }
  return undefined;
}

function rulesBySource(permissionContext: ToolPermissionContext, behavior: PermissionBehavior): ToolPermissionRulesBySource {
  switch (behavior) {
    case 'allow': return permissionContext.alwaysAllowRules;
    case 'deny': return permissionContext.alwaysDenyRules;
    case 'ask': return permissionContext.alwaysAskRules;
  }
}
