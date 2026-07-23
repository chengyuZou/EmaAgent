// Task Context 把持久工作项投影成低频动态提醒，不进入稳定 System Prompt。

import type { Task } from './types.js';

export function formatTaskContextReminder(tasks: readonly Task[]): string {
  const displayNumberById = new Map(
    tasks.map((task) => [task.id, task.displayNumber] as const),
  );
  const lines = tasks.map((task) => {
    const blocked = task.blockedBy.length > 0
      ? `，被 ${task.blockedBy.map((id) => {
          const number = displayNumberById.get(id);
          return number === undefined ? id.slice(0, 8) : `#${number}`;
        }).join('、')} 阻塞`
      : '';
    return `#${task.displayNumber} [${task.status}] ${task.subject}${blocked} (version ${task.version})`;
  });
  return [
    '[Task reminder]',
    '任务工具已有一段时间未更新。继续复杂工作前请核对当前清单；不要向用户复述本提醒。',
    ...lines,
  ].join('\n');
}
