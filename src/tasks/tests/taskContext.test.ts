// 验证动态 Task 提醒使用 Session 短序号表达依赖，不把内部 UUID 暴露给模型。

import { describe, expect, it } from 'vitest';
import type { Task } from '../types.js';
import { formatTaskContextReminder } from '../taskContext.js';

describe('Task Context 提醒', () => {
  it('用短序号展示工作项和依赖版本', () => {
    const first = makeTask('task-first', 1, 'Prepare');
    const second = makeTask('task-second', 2, 'Execute', [first.id]);

    const reminder = formatTaskContextReminder([first, second]);

    expect(reminder).toContain('#1 [pending] Prepare');
    expect(reminder).toContain('#2 [pending] Execute，被 #1 阻塞');
    expect(reminder).not.toContain('task-first');
  });
});

function makeTask(
  id: string,
  displayNumber: number,
  subject: string,
  blockedBy: Task['blockedBy'] = [],
): Task {
  return {
    id,
    sessionId: 'session-task',
    displayNumber,
    subject,
    description: subject,
    status: 'pending',
    blocks: [],
    blockedBy,
    createdByTurnId: 'turn-task',
    version: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}
