import {
  findMatchingContentRule,
  matchShellRule,
  parsePermissionRule,
  shellCommandToRuleContent,
  type PermissionResult,
  type PermissionRule,
  type PermissionRuleSource,
  type ToolPermissionContext,
} from '@ema-agent/permission';

export function checkShellContentPermission(
  toolName: string,
  command: string,
  commands: readonly string[],
  allowByCommands: boolean,
  permissionContext: ToolPermissionContext,
): PermissionResult {
  const sessionAllowRule = {
    toolName,
    ruleContent: shellCommandToRuleContent(command),
  };
  const contentDecision = (behavior: 'deny' | 'ask'): PermissionResult | undefined => {
    const rule = findMatchingContentRule(
      permissionContext, toolName, behavior,
      content => matchShellRule(content, command)
        || commands.some(subcommand => matchShellRule(content, subcommand)),
    );
    if (rule) {
      if (behavior === 'deny') {
        return {
          behavior: 'deny',
          message: `已禁止执行: ${command}`,
          decisionReason: { type: 'rule', rule },
        };
      }
      return {
        behavior: 'ask',
        message: `执行 ${command} 需要用户确认`,
        decisionReason: { type: 'rule', rule },
        sessionAllowRule,
      };
    }
    return undefined;
  };
  const denied = contentDecision('deny');
  if (denied) {
    return denied;
  }
  const allowRule = (source?: PermissionRuleSource): PermissionRule | undefined => {
    // 完整调用可直接命中; 模式规则必须覆盖可信解析出的每一条命令.
    const exactRule = findMatchingContentRule(
      permissionContext, toolName, 'allow',
      content => parsePermissionRule(content).type === 'exact' && matchShellRule(content, command), source,
    );
    if (exactRule) {
      return exactRule;
    }

    if (allowByCommands && commands.length > 0) {
      let matchedRule: PermissionRule | undefined;
      for (const subcommand of commands) {
        matchedRule = findMatchingContentRule(
          permissionContext, toolName, 'allow', content => matchShellRule(content, subcommand), source,
        );
        if (!matchedRule) {
          return undefined;
        }
      }
      return matchedRule;
    }
    return undefined;
  };
  const sessionRule = allowRule('session');
  if (sessionRule) {
    return { behavior: 'allow', decisionReason: { type: 'rule', rule: sessionRule }, sessionAllowRule };
  }
  const asked = contentDecision('ask');
  if (asked) {
    return asked;
  }
  const matchedRule = allowRule();
  if (matchedRule) {
    return { behavior: 'allow', decisionReason: { type: 'rule', rule: matchedRule }, sessionAllowRule };
  }
  return { behavior: 'passthrough', message: '执行命令需要用户确认', sessionAllowRule };
}
