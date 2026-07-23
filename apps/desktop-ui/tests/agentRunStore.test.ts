// 测试 AgentRun 原生快照与实时事件并发时不会回退子智能体状态。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRunsApi, type AgentRunWire } from '../src/api/agentRuns.js';
import { useAgentRunStore } from '../src/stores/agentRunStore.js';

const SESSION_ID = 'session-agent-run-store';

afterEach(() => {
  vi.restoreAllMocks();
  useAgentRunStore.setState({
    runs: new Map(),
    transcripts: new Map(),
    loadingSessions: new Set(),
    eventRevisions: new Map(),
    error: null,
  });
});

describe('AgentRun Store', () => {
  it('从原生接口读取完整 AgentRun 快照', async () => {
    const run = makeRun({ id: 'run-1', purpose: '检查代码', taskId: 'task-1' });
    vi.spyOn(agentRunsApi, 'list').mockResolvedValueOnce({ runs: [run] });

    await useAgentRunStore.getState().loadForSession(SESSION_ID);

    expect(useAgentRunStore.getState().runs.get(run.id)).toEqual(run);
    expect(useAgentRunStore.getState().loadingSessions.has(SESSION_ID)).toBe(false);
  });

  it('加载期间收到实时事件时丢弃旧响应并重新读取权威快照', async () => {
    let resolveFirst: ((value: { runs: AgentRunWire[] }) => void) | undefined;
    const firstResponse = new Promise<{ runs: AgentRunWire[] }>((resolve) => {
      resolveFirst = resolve;
    });
    const latest = makeRun({
      id: 'run-2',
      status: 'completed',
      version: 2,
      completedAt: 30,
    });
    vi.spyOn(agentRunsApi, 'list')
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce({ runs: [latest] });

    const loading = useAgentRunStore.getState().loadForSession(SESSION_ID);
    useAgentRunStore.getState().upsert(makeRun({ id: 'run-2', version: 1 }));
    resolveFirst?.({ runs: [makeRun({ id: 'run-2', version: 0 })] });
    await loading;

    expect(agentRunsApi.list).toHaveBeenCalledTimes(2);
    expect(useAgentRunStore.getState().runs.get('run-2')?.version).toBe(2);
    expect(useAgentRunStore.getState().runs.get('run-2')?.status).toBe('completed');
  });
});

function makeRun(overrides: Partial<AgentRunWire> = {}): AgentRunWire {
  return {
    id: 'run-default',
    sessionId: SESSION_ID,
    parentTurnId: 'turn-parent',
    kind: 'subagent',
    status: 'running',
    version: 1,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}
