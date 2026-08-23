// Task Context 把持久工作项投影成低频动态提醒，不进入稳定 System Prompt。

import type { Task } from './types.js';

export function formatTaskContextReminder(tasks: readonly Task[]): string {
  const lines = tasks.map((task) =>
    `#${task.displayNumber} [${task.status}] ${task.subject} (version ${task.version})`,
  );
  return [
    '[Task reminder]',
    '任务工具已有一段时间未更新。继续复杂工作前请核对当前清单；不要向用户复述本提醒。',
    ...lines,
  ].join('\n');
}
