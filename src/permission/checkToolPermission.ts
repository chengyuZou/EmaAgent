import type {
  PermissionCheckableTool,
  PermissionCheckResult,
  PermissionContext,
  PermissionRule,
  ToolPermissionCheck,
} from './types.js';
import { getSessionApprovals } from './rules/sessionApprovals.js';
import { prepareFilePermission } from './checks/file/pathPermission.js';
import { prepareShellPermission } from './checks/shell/shellPermission.js';
import { prepareWebPermission } from './checks/webPermission.js';
import { prepareMcpPermission } from './checks/mcpPermission.js';
import { prepareComputerUsePermission } from './checks/computerUsePermission.js';
import { exactInputCondition, matchesRules, type PreparedPermissionCheck } from './checks/preparedPermissionCheck.js';

// Tool 的输入已由执行器校验. 调用 checkPermissions 和分类检查都留在 Permission 内部.
export async function checkToolPermission<TInput, TContext>(
  tool: PermissionCheckableTool<TInput, TContext>,
  input: TInput,
  toolContext: TContext,
  permissionContext: PermissionContext,
  options: { readonly interactive: boolean },
): Promise<PermissionCheckResult> {
  const configuredRules = permissionContext.rules.filter(rule => rule.key.toolName === tool.name);
  if (configuredRules.some(rule => rule.decision === 'deny' && rule.key.condition === undefined)) {
    return { decision: 'deny', message: `已禁止使用 ${tool.name}` };
  }

  const toolPermissionCheck = await tool.checkPermissions(input, toolContext);
  const preparedPermissionCheck = prepareCheck(tool.name, input, toolPermissionCheck, permissionContext);
  // Tool 检查可能异步解析命令, 因此在它返回后读取最新的 Session 批准.
  const rules: PermissionRule[] = [
    ...getSessionApprovals(permissionContext.sessionId).map(key => ({
      key,
      decision: 'allow' as const,
      from: 'session' as const,
    })),
    ...configuredRules,
  ];
  const matches = (decision: 'allow' | 'deny' | 'ask') => matchesRules(
    tool.name,
    preparedPermissionCheck,
    rules.filter(rule => rule.decision === decision).map(rule => rule.key),
    decision,
  );
  const ask = (): PermissionCheckResult => {
    if (!options.interactive) {
      return { decision: 'deny', message: `${preparedPermissionCheck.message} 当前没有可用的用户确认入口.` };
    }
    return {
      decision: 'ask',
      message: preparedPermissionCheck.message,
      ...(preparedPermissionCheck.sessionApproval ? { sessionApproval: preparedPermissionCheck.sessionApproval } : {}),
    };
  };

  if (matches('deny')) return { decision: 'deny', message: `已禁止本次 ${tool.name} 操作` };

  // 无可记住范围的必要确认不能被旧 Session 批准覆盖, 不能凭空生成批准范围.
  if (preparedPermissionCheck.confirmation === 'required' && !preparedPermissionCheck.sessionApproval) return ask();
  if (preparedPermissionCheck.confirmation === 'alreadyApproved') return { decision: 'allow' };

  const sessionKeys = rules
    .filter(rule => rule.from === 'session' && rule.decision === 'allow')
    .map(rule => rule.key);
  if (matchesRules(tool.name, preparedPermissionCheck, sessionKeys, 'allow')) {
    return { decision: 'allow' };
  }
  if (matches('ask') || preparedPermissionCheck.confirmation === 'required') return ask();
  if (permissionContext.mode === 'bypassPermissions') return { decision: 'allow' };
  if (matches('allow') || preparedPermissionCheck.defaultDecision === 'allow') return { decision: 'allow' };
  return ask();
}

function prepareCheck(
  toolName: string,
  input: unknown,
  toolPermissionCheck: ToolPermissionCheck,
  context: PermissionContext,
): PreparedPermissionCheck {
  switch (toolPermissionCheck.kind) {
    case 'file':
      return prepareFilePermission(toolName, toolPermissionCheck, context, input);
    case 'shell':
      return prepareShellPermission(toolName, toolPermissionCheck);
    case 'webFetch':
    case 'webSearch':
      return prepareWebPermission(toolName, toolPermissionCheck);
    case 'mcp':
      return prepareMcpPermission(toolName, input, toolPermissionCheck.reportedDestructive);
    case 'computerUse':
      return prepareComputerUsePermission(toolName, toolPermissionCheck.needsStartupApproval);
    case 'tool': {
      const condition = toolPermissionCheck.sessionApproval === 'input' ? exactInputCondition(input) : undefined;
      return {
        defaultDecision: toolPermissionCheck.defaultDecision,
        message: toolPermissionCheck.message ?? `允许执行 ${toolName} 吗?`,
        confirmation: 'byRules',
        matchesConditions: conditions => condition !== undefined && conditions.includes(condition),
        ...(toolPermissionCheck.sessionApproval ? {
          sessionApproval: {
            key: { toolName, ...(condition !== undefined ? { condition } : {}) },
            description: condition === undefined
              ? `本会话允许使用 ${toolName}.`
              : `本会话允许 ${toolName} 使用与本次完全相同的参数.`,
          },
        } : {}),
      };
    }
  }
}
