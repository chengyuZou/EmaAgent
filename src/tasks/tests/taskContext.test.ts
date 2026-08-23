// 验证动态 Task 提醒用 Session 短序号表达工作项，不把内部 UUID 暴露给模型。

import { describe, expect, it } from 'vitest';
import type { Task } from '../types.js';
import { formatTaskContextReminder } from '../taskContext.js';

describe('Task Context 提醒', () => {
  it('用短序号展示工作项与版本', () => {
    const first = makeTask('task-first', 1, 'Prepare');
    const second = makeTask('task-second', 2, 'Execute');

    const reminder = formatTaskContextReminder([first, second]);

    expect(reminder).toContain('#1 [pending] Prepare (version 0)');
    expect(reminder).toContain('#2 [pending] Execute (version 0)');
    expect(reminder).not.toContain('task-first');
  });
});

function makeTask(
  id: string,
  displayNumber: number,
  subject: string,
): Task {
  return {
    id,
    sessionId: 'session-task',
    displayNumber,
    subject,
    description: subject,
    status: 'pending',
    createdByTurnId: 'turn-task',
    version: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}
