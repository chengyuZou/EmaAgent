import type { PreparedPermissionCheck } from './preparedPermissionCheck.js';

export function prepareComputerUsePermission(needsStartupApproval: boolean): PreparedPermissionCheck {
  return {
    defaultDecision: 'allow',
    confirmation: needsStartupApproval ? 'required' : 'alreadyApproved',
    message: '允许 Ema 启动电脑操控吗? 操控期间可观察窗口并执行键鼠操作. 用户输入会暂停, Ctrl+Alt+C 继续, Esc 结束操控.',
    matchesConditions: () => false,
    // 启动批准由 ComputerUse 保存到本次操控结束, 不生成另一份 Session 规则.
  };
}
