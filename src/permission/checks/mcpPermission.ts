import { exactInputCondition, type PreparedPermissionCheck } from './preparedPermissionCheck.js';

export function prepareMcpPermission(
  toolName: string,
  input: unknown,
  reportedDestructive: boolean,
): PreparedPermissionCheck {
  // MCP 参数没有统一的路径或命令含义, 明确只批准当前工具的相同参数.
  const condition = exactInputCondition(input);
  return {
    defaultDecision: 'ask',
    confirmation: reportedDestructive ? 'required' : 'byRules',
    message: reportedDestructive
      ? `MCP 服务报告 ${toolName} 可能产生破坏性影响, 是否允许本次调用?`
      : `允许调用 MCP 工具 ${toolName} 吗?`,
    matchesConditions: conditions => conditions.includes(condition),
    sessionApproval: {
      key: { toolName, condition },
      description: `本会话允许 ${toolName} 使用与本次完全相同的参数.`,
    },
  };
}
