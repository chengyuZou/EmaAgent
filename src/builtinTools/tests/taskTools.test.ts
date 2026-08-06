// Task 四件套收口测试:窄 Context 投影、调用身份从 ToolInvocation 取(运行时修复核心)、
// expectedVersion CAS 透传、失败原因映射、List 隐藏已完成阻塞项。
// 事件不在此处断言:task_created/updated/deleted 由 wiring 侧 store 装饰器发出,Tool 不发射。

import { describe, expect, it, vi } from 'vitest';
import {
  asSessionId,
  asTaskId,
  asToolCallId,
  asTurnId,
} from '@ema-agent/ids';
import type { ToolInvocation } from '@ema-agent/tools';
import type { Task, TaskSnapshot, TaskStorePort } from '@ema-agent/tasks';
import { TaskCreateTool } from '../tools/TaskCreateTool/TaskCreateTool.js';
import { TaskGetTool } from '../tools/TaskGetTool/TaskGetTool.js';
import { TaskListTool } from '../tools/TaskListTool/TaskListTool.js';
import { TaskUpdateTool } from '../tools/TaskUpdateTool/TaskUpdateTool.js';

const taskId = asTaskId('11111111-1111-4111-8111-111111111111');
const sessionId = asSessionId('00000000-0000-4000-8000-0000000000b1');
const turnId = asTurnId('00000000-0000-4000-8000-0000000000b2');

function makeInvocation(): ToolInvocation {
  return {
    sessionId,
    turnId,
    toolCallId: asToolCallId('call-task-1'),
    signal: new AbortController().signal,
  };
}

// 经 validateContext 从 ToolUseContext 投影窄 Context;缺 taskStore 时必须拒绝(子 Agent 环境)。
function project(store: TaskStorePort) {
  const projection = TaskCreateTool.validateContext({ taskStore: store } as never);
  if (!projection.valid) throw new Error('投影应成功');
  return projection.context;
}

describe('TaskCreateTool', () => {
  it('用 invocation 的 sessionId/turnId 调 store,返回持久快照', async () => {
    const task = makeTask();
    const store = makeStore(task);

    const result = await TaskCreateTool.execute({
      subject: 'Run tests',
      description: 'Run the relevant integration tests',
      activeForm: 'Running tests',
    }, project(store), makeInvocation());

    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      turnId,
      subject: 'Run tests',
    }));
    expect(result.task).toMatchObject({ id: taskId, displayNumber: 1 });
  });

  it('缺 taskStore 时投影失败(子 Agent 不可见)', () => {
    expect(TaskCreateTool.validateContext({} as never).valid).toBe(false);
  });
});

describe('TaskGetTool', () => {
  it('命中返回快照;未命中返回 null 而非抛错', async () => {
    const task = makeTask();
    const store = makeStore(task);

    const hit = await TaskGetTool.execute({ taskId }, project(store), makeInvocation());
    expect(hit.task).toMatchObject({ id: taskId });

    vi.mocked(store.get).mockReturnValue(undefined);
    const miss = await TaskGetTool.execute({ taskId }, project(store), makeInvocation());
    expect(miss.task).toBeNull();
    expect(miss.message).toContain('not found');
  });
});

describe('TaskListTool', () => {
  it('已完成的阻塞项从 blockedBy 中隐藏,活跃 AgentRun 如实透出', async () => {
    const blocker = makeTask({
      id: asTaskId('22222222-2222-4222-8222-222222222222'),
      status: 'completed',
    });
    const blocked = makeTask({
      id: taskId,
      blockedBy: [blocker.id],
      activeAgentRunId: '33333333-3333-4333-8333-333333333333' as never,
    });
    const store = makeStore(blocked);
    vi.mocked(store.list).mockReturnValue([blocker, blocked]);

    const result = await TaskListTool.execute({}, project(store), makeInvocation());

    const item = result.tasks.find((t) => t.id === taskId)!;
    expect(item.blockedBy).toEqual([]);
    expect(item.activeAgentRunId).toBeDefined();
    expect(store.list).toHaveBeenCalledWith(sessionId);
  });
});

describe('TaskUpdateTool', () => {
  it('expectedVersion 与 invocation 身份原样透传给 store', async () => {
    const task = makeTask({ status: 'completed', version: 2 });
    const store = makeStore(task);
    vi.mocked(store.update).mockReturnValue({
      ok: true,
      changed: true,
      deleted: false,
      task,
    });

    const result = await TaskUpdateTool.execute({
      taskId,
      expectedVersion: 1,
      status: 'completed',
    }, project(store), makeInvocation());

    expect(store.update).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      turnId,
      taskId,
      expectedVersion: 1,
      status: 'completed',
    }));
    expect(result).toMatchObject({ success: true, changed: true, deleted: false });
  });

  it('version_conflict 返回当前快照与重试提示', async () => {
    const current = makeTask({ version: 3 });
    const store = makeStore(current);
    vi.mocked(store.update).mockReturnValue({
      ok: false,
      reason: 'version_conflict',
      current,
    });

    const result = await TaskUpdateTool.execute({
      taskId,
      expectedVersion: 1,
      status: 'completed',
    }, project(store), makeInvocation());

    expect(result.success).toBe(false);
    expect(result.reason).toBe('version_conflict');
    expect(result.message).toContain('TaskGet');
    expect(result.current).toMatchObject({ version: 3 });
  });

  it('delete 走 action 通道并返回 deleted 标记', async () => {
    const store = makeStore(makeTask());
    vi.mocked(store.update).mockReturnValue({
      ok: true,
      changed: true,
      deleted: true,
      taskId,
    });

    const result = await TaskUpdateTool.execute({
      taskId,
      expectedVersion: 1,
      action: 'delete',
    }, project(store), makeInvocation());

    expect(result).toMatchObject({ success: true, deleted: true });
    expect(result.task).toBeUndefined();
  });

  it('changed=false 时不虚报更新', async () => {
    const store = makeStore(makeTask());
    // makeStore 默认 update 返回 changed:false。
    const result = await TaskUpdateTool.execute({
      taskId,
      expectedVersion: 0,
      subject: 'Run tests',
    }, project(store), makeInvocation());

    expect(result.success).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.message).toContain('already matches');
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
