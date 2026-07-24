// 验证根 Turn 的 Task 工具使用同一 TaskStore 快照返回结果并发送结构化事件。

import { describe, expect, it, vi } from 'vitest';
import {
  asSessionId,
  asTaskId,
  asTurnId,
} from '@ema-agent/ids';
import type { Task, TaskStorePort } from '@ema-agent/tasks';
import type { ToolExecutionEvent as EmaStreamEvent } from '@ema-agent/tools';
import type { TaskSnapshot } from '@ema-agent/tasks';
import { asToolCallId } from '@ema-agent/ids';
import type {
  ToolExecutionScope,
  ToolInvocationContext,
} from '@ema-agent/tools';
import { TaskCreateTool } from '../tools/TaskCreateTool/TaskCreateTool.js';
import { TaskUpdateTool } from '../tools/TaskUpdateTool/TaskUpdateTool.js';

const taskId = asTaskId('11111111-1111-4111-8111-111111111111');
const sessionId = asSessionId('session-task-tool');
const turnId = asTurnId('turn-task-tool');

describe('Task 工具', () => {
  it('TaskCreate 返回持久快照并发送 task_created', async () => {
    const task = makeTask();
    const store = makeStore(task);
    const events: EmaStreamEvent[] = [];

    const result = await TaskCreateTool.execute({
      subject: 'Run tests',
      description: 'Run the relevant integration tests',
      activeForm: 'Running tests',
    }, ...makeContext(store, events));

    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      turnId,
      subject: 'Run tests',
    }));
    expect(result.task).toMatchObject({ id: taskId, displayNumber: 1 });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'task_created',
        sessionId,
        turnId,
        task: expect.objectContaining({ id: taskId }),
      }),
    ]);
  });

  it('TaskUpdate 使用 expectedVersion，并只在实际变更时发送 task_updated', async () => {
    const task = makeTask({ status: 'completed', version: 2 });
    const store = makeStore(task);
    vi.mocked(store.update).mockReturnValue({
      ok: true,
      changed: true,
      deleted: false,
      task,
    });
    const events: EmaStreamEvent[] = [];

    const result = await TaskUpdateTool.execute({
      taskId,
      expectedVersion: 1,
      status: 'completed',
    }, ...makeContext(store, events));

    expect(store.update).toHaveBeenCalledWith(expect.objectContaining({
      taskId,
      expectedVersion: 1,
      status: 'completed',
    }));
    expect(result).toMatchObject({ success: true, changed: true, deleted: false });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'task_updated',
        task: expect.objectContaining({ status: 'completed', version: 2 }),
      }),
    ]);
  });
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
    sessionId,
    displayNumber: 1,
    subject: 'Run tests',
    description: 'Run the relevant integration tests',
    activeForm: 'Running tests',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    createdByTurnId: turnId,
    version: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeStore(task: Task): TaskStorePort {
  const snapshot = task as TaskSnapshot;
  return {
    create: vi.fn(() => task),
    get: vi.fn(() => task),
    list: vi.fn(() => [task]),
    update: vi.fn(() => ({
      ok: true,
      changed: false,
      deleted: false,
      task,
    })),
    takeContextReminder: vi.fn(() => []),
    toSnapshot: vi.fn(() => snapshot),
  };
}

function makeContext(
  taskStore: TaskStorePort,
  events: EmaStreamEvent[],
): [ToolInvocationContext, ToolExecutionScope] {
  return [{
    sessionId,
    turnId,
    toolCallId: asToolCallId('task-tool-call'),
    workspaceRoot: '',
    signal: new AbortController().signal,
  }, {
    readFileState: new Map(),
    taskStore,
    emit: (event) => events.push(event),
  }];
}
