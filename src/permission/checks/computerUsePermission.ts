import type { PreparedPermissionCheck } from './preparedPermissionCheck.js';

export function prepareComputerUsePermission(toolName: string, needsStartupApproval: boolean): PreparedPermissionCheck {
  return {
    defaultDecision: 'allow',
    confirmation: needsStartupApproval ? 'required' : 'alreadyApproved',
    message: '允许 Ema 启动电脑操控吗? 操控期间可观察窗口并执行键鼠操作. 按 Esc 可结束操控, 当前 Turn 结束后也会自动结束.',
    matchesConditions: () => false,
    ...(needsStartupApproval ? {
      sessionApproval: {
        key: { toolName },
        description: '本会话允许启动电脑操控, 包括窗口观察、键鼠和控件操作. 每次操控仍在所属 Turn 结束时关闭.',
      },
    } : {}),
  };
}
