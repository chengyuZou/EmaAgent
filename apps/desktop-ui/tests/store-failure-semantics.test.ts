// 测试 Session、分支、Agent Task、Memory 与 KB 失败时不会伪造成功或丢失事实状态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@ema-agent/ids';

vi.mock('@ema-agent/live2d-react', () => ({
  useSpeechStore: {
    getState: () => ({
      setSpeaking: vi.fn(),
      setRms: vi.fn(),
      reset: vi.fn(),
    }),
  },
}));

import { sessionsApi } from '../src/api/sessions.js';
import { agentTasksApi } from '../src/api/agent-tasks.js';
import { turnsApi } from '../src/api/turns.js';
import { kbApi } from '../src/api/knowledge-base.js';
import { useSessionStore } from '../src/stores/session-store.js';
import {
  useConversationStore,
  type BranchLoadState,
} from '../src/stores/conversation-store.js';
import {
  useAgentTaskStore,
  type AgentTaskState,
} from '../src/stores/agent-task-store.js';
import { useMemoryStore } from '../src/stores/memory-store.js';
import { useKbStore, type IngestJob } from '../src/stores/kb-store.js';

const SESSION_ID = 'session-failure-test' as SessionId;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Store 失败语义', () => {
  it('创建 Session 失败时 reject，不再返回伪造的 SessionId', async () => {
    const failure = new Error('database unavailable');
    vi.spyOn(sessionsApi, 'create').mockRejectedValueOnce(failure);
    useSessionStore.setState({ error: null });

    await expect(useSessionStore.getState().createSession()).rejects.toBe(failure);
    expect(useSessionStore.getState().error).toBe('database unavailable');
  });

  it('分支刷新失败时保留旧树并标记 stale', async () => {
    const existing = {
      branches: [],
      turns: [],
      sessionActiveBranchId: null,
    };
    useConversationStore.setState({
      branchDataBySession: new Map([[SESSION_ID as string, existing]]),
      branchLoadStateBySession: new Map<string, BranchLoadState>(),
    });
    vi.spyOn(sessionsApi, 'listBranches').mockRejectedValueOnce(new Error('branch timeout'));

    await expect(useConversationStore.getState().loadBranches(SESSION_ID)).rejects.toThrow('branch timeout');
    expect(useConversationStore.getState().branchDataBySession.get(SESSION_ID as string)).toBe(existing);
    expect(useConversationStore.getState().branchLoadStateBySession.get(SESSION_ID as string))
      .toMatchObject({ status: 'stale', error: 'branch timeout' });
  });

  it('运行中 Agent Task 取消失败时不删除持久化记录或 UI 记录', async () => {
    const task = {
      id: 'task-running',
      sessionId: SESSION_ID as string,
      status: 'running',
      parentTurnId: 'turn-parent',
    } as AgentTaskState;
    useAgentTaskStore.setState({ tasks: new Map([[task.id, task]]), error: null });
    vi.spyOn(turnsApi, 'abortSubagent').mockRejectedValueOnce(new Error('runtime unreachable'));
    const deleteRequest = vi.spyOn(agentTasksApi, 'delete');

    await expect(
      useAgentTaskStore.getState().deleteTask(task.id, task.parentTurnId),
    ).rejects.toThrow('runtime unreachable');

    expect(deleteRequest).not.toHaveBeenCalled();
    expect(useAgentTaskStore.getState().tasks.get(task.id)).toBe(task);
    expect(useAgentTaskStore.getState().error).toBe('runtime unreachable');
  });

  it('Memory 后台任务失败后保留错误、任务类型和 Session', () => {
    const store = useMemoryStore.getState();
    store.onTaskStarted('memory-task', 'extraction', SESSION_ID as string);
    store.onTaskFailed('memory-task', 'embedding failed');

    expect(useMemoryStore.getState().activeTasks.has('memory-task')).toBe(false);
    expect(useMemoryStore.getState().failedTasks.get('memory-task')).toMatchObject({
      error: 'embedding failed',
      task: { kind: 'extraction', sessionId: SESSION_ID as string },
    });
  });

  it('早到的 KB completed 事件会建立终态记录而不是被丢弃', () => {
    vi.useFakeTimers();
    vi.spyOn(kbApi, 'listDocuments').mockResolvedValue({ items: [] } as never);
    useKbStore.setState({
      ingestJobs: {},
      ingestDoneCount: 0,
      ingestCompletedAssets: new Set(),
    });

    useKbStore.getState().onIngestCompleted('kb-1', 'asset-early');
    useKbStore.getState().onIngestCompleted('kb-1', 'asset-early');

    expect(useKbStore.getState().ingestJobs['asset-early']).toMatchObject({
      kbId: 'kb-1',
      assetId: 'asset-early',
      status: 'done',
      progress: 1,
    });
    expect(useKbStore.getState().ingestDoneCount).toBe(1);

    vi.advanceTimersByTime(350);
    expect(useKbStore.getState().ingestJobs['asset-early']).toBeUndefined();
  });

  it('KB 队列刷新失败时保留旧快照并记录刷新错误', async () => {
    const existing = {
      taskId: 'task-1',
      assetId: 'asset-1',
      kbId: 'kb-1',
      fileName: 'doc.pdf',
      progress: 0.5,
      status: 'running',
    } satisfies IngestJob;
    useKbStore.setState({ ingestJobs: { [existing.assetId]: existing }, ingestQueueError: null });
    vi.spyOn(kbApi, 'getIngestTasks').mockRejectedValueOnce(new Error('queue offline'));

    await useKbStore.getState().loadIngestTasks();

    expect(useKbStore.getState().ingestJobs[existing.assetId]).toBe(existing);
    expect(useKbStore.getState().ingestQueueError).toBe('queue offline');
  });
});
