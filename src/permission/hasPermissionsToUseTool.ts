// 权限判定的唯一中央入口：固定优先级，Tool 自我解释，中央不解释 ruleContent 语义。
// 模式分工：default/bypassPermissions 由中央处理；acceptEdits 是 Tool 侧语义
// （"工作区内写入放行"只有文件 Tool 知道怎么判定，归各自的 checkPermissions）。
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
  /** 有宿主交互通道时 ask 才等待批准, 根与子代理共用 Session 通道; 否则 deny. */
  readonly interactive: boolean;
}

/**
 * 外层：无交互通道时把 ask 收口为 deny（headless）。
 */
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
  // 1. 整体 Tool deny 规则
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

  // 4. bypassPermissions；显式 deny 与 Tool ask 已在前面拦截。
  if (permissionContext.mode === 'bypassPermissions') {
    return { behavior: 'allow', decisionReason: { type: 'mode', mode: 'bypassPermissions' } };
  }

  // 5. 整体 Tool allow 规则
  const allowRule = findWholeToolRule(permissionContext.alwaysAllowRules, tool.name, 'allow');
  if (allowRule) {
    return { behavior: 'allow', decisionReason: { type: 'rule', rule: allowRule } };
  }

  // 6. Tool 自我放行；passthrough 收口为 ask
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

/** source 优先级：session > projectSettings > userSettings（更具体的范围先生效）。 */
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
 * 内容级规则查询：findWholeToolRule 的内容版——该工具全部带 ruleContent 的规则。
 * 只含 ruleContent（整体规则 Bash 不参与）；source 优先级 session > project > user。
 * 精确匹配（域名/路径语义串）用 findContentRule；模式匹配（Bash git *）遍历本数组。
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

/** 单条内容规则精确命中（ruleContent 是 Tool 自转的语义串，如 WebFetch 域名）。 */
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
 * 谓词匹配：规则内容是模式（Bash `git *`、路径 glob），Tool 传语义匹配谓词。
 * Bash 传 (c) => matchShellRule(c, command)；文件 Tool 传 (c) => matchPathRule(c, path, root)。
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
