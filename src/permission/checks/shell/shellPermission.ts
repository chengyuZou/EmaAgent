import type { ShellPermissionCheck } from '../../types.js';
import type { PreparedPermissionCheck } from '../preparedPermissionCheck.js';
import { getPathsForPermissionCheck, normalizeCaseForComparison } from '../file/pathSafety.js';
import { matchShellRule, parsePermissionRule, shellCommandToRuleContent } from './shellRuleMatching.js';

export function prepareShellPermission(toolName: string, check: ShellPermissionCheck): PreparedPermissionCheck {
  // 本地目录比较实际目标, 避免切换链接目标后沿用旧批准. 网络目录在批准前不访问.
  const isNetwork = check.cwd.startsWith('\\\\') || check.cwd.startsWith('//');
  const cwd = normalizeCaseForComparison(isNetwork
    ? check.cwd
    : getPathsForPermissionCheck(check.cwd).at(-1)!);
  return {
    cwd,
    defaultDecision: 'ask',
    confirmation: 'byRules',
    message: `允许在 ${check.cwd} 执行命令: ${check.command}?`,
    sessionApproval: {
      key: { toolName, condition: shellCommandToRuleContent(check.command), cwd },
      description: `本会话允许 ${toolName} 在 ${check.cwd} 执行这条完整命令, 不包含其他目录, 命令或新增参数.`,
    },
    matchesConditions(conditions, decision) {
      if (decision !== 'allow') {
        return conditions.some(condition => matchShellRule(condition, check.command)
          || check.subcommands.some(command => matchShellRule(condition, command)));
      }

      // 完整命令的精确批准可以直接匹配. 前缀或通配批准必须覆盖所有可靠解析出的子命令.
      if (conditions.some(condition => parsePermissionRule(condition).type === 'exact'
        && matchShellRule(condition, check.command))) {
        return true;
      }
      return check.canMatchSubcommands && check.subcommands.length > 0
        && check.subcommands.every(command => conditions.some(condition => matchShellRule(condition, command)));
    },
  };
}
