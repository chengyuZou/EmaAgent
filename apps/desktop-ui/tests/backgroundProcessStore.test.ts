// 测试后台进程 store:SSE 事件原位更新、未加载不预取、Session 删除清理、输出缓冲封顶。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundProcessSummary } from '@ema-agent/tools';

const listMock = vi.fn();
const readOutputMock = vi.fn();
const stopMock = vi.fn();

vi.mock('../src/api/backgroundProcesses.js', () => ({
  backgroundProcessesApi: {
    list: (...args: unknown[]) => listMock(...args),
    readOutput: (...args: unknown[]) => readOutputMock(...args),
    stop: (...args: unknown[]) => stopMock(...args),
  },
}));

import { useBackgroundProcessStore } from '../src/stores/backgroundProcessStore.js';

function summary(overrides: Partial<BackgroundProcessSummary> = {}): BackgroundProcessSummary {
  return {
    id: 'p-1' as BackgroundProcessSummary['id'],
    sessionId: 's-1' as BackgroundProcessSummary['sessionId'],
    command: 'npm run build',
    cwd: '/repo',
    status: 'running',
    createdAt: 1,
    durationMs: 10,
    stdoutBytes: 0,
    stderrBytes: 0,
    outputTruncated: false,
    outputDir: '/data/sessions/s-1/p-1',
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockReset();
  readOutputMock.mockReset();
  stopMock.mockReset();
  useBackgroundProcessStore.setState({
    listsBySession: new Map(),
    outputsById: new Map(),
  });
});

describe('backgroundProcessStore', () => {
  it('loadForSession 写入列表并标记 ready', async () => {
    listMock.mockResolvedValue({ processes: [summary()] });
    await useBackgroundProcessStore.getState().loadForSession('s-1');
    const list = useBackgroundProcessStore.getState().listsBySession.get('s-1');
    expect(list?.status).toBe('ready');
    expect(list?.processes).toHaveLength(1);
  });

  it('事件原位更新已加载行,不重拉', async () => {
    listMock.mockResolvedValue({ processes: [summary()] });
    await useBackgroundProcessStore.getState().loadForSession('s-1');
    listMock.mockClear();

    useBackgroundProcessStore.getState().applyEvent({
      type: 'background_process_changed',
      sessionId: 's-1' as never,
      backgroundProcessId: 'p-1' as never,
      status: 'failed',
      at: 2,
      exitCode: 1,
      terminationReason: 'Command exited with code 1',
    });

    const list = useBackgroundProcessStore.getState().listsBySession.get('s-1');
    expect(list?.processes[0]).toMatchObject({
      status: 'failed',
      exitCode: 1,
      terminationReason: 'Command exited with code 1',
    });
    expect(listMock).not.toHaveBeenCalled();
  });

  it('面板未加载该 Session 时事件不预取', () => {
    useBackgroundProcessStore.getState().applyEvent({
      type: 'background_process_changed',
      sessionId: 's-x' as never,
      backgroundProcessId: 'p-x' as never,
      status: 'completed',
      at: 2,
    });
    expect(listMock).not.toHaveBeenCalled();
    expect(useBackgroundProcessStore.getState().listsBySession.size).toBe(0);
  });

  it('clearSession 清理列表与输出缓存', async () => {
    listMock.mockResolvedValue({ processes: [summary()] });
    readOutputMock.mockResolvedValue({
      process: summary(),
      stdout: 'hello',
      stderr: '',
      nextCursor: 'cursor-1',
      hasMore: false,
    });
    await useBackgroundProcessStore.getState().loadForSession('s-1');
    await useBackgroundProcessStore.getState().readOutput('s-1', 'p-1');
    expect(useBackgroundProcessStore.getState().outputsById.has('p-1')).toBe(true);

    useBackgroundProcessStore.getState().clearSession('s-1');
    expect(useBackgroundProcessStore.getState().listsBySession.size).toBe(0);
    expect(useBackgroundProcessStore.getState().outputsById.size).toBe(0);
  });

  it('readOutput 追加并封顶渲染缓冲', async () => {
    listMock.mockResolvedValue({ processes: [summary()] });
    const bigChunk = 'x'.repeat(60 * 1024);
    readOutputMock
      .mockResolvedValueOnce({
        process: summary(), stdout: bigChunk, stderr: '', nextCursor: 'c1', hasMore: true,
      })
      .mockResolvedValueOnce({
        process: summary(), stdout: bigChunk, stderr: '', nextCursor: 'c2', hasMore: true,
      });
    await useBackgroundProcessStore.getState().readOutput('s-1', 'p-1');
    await useBackgroundProcessStore.getState().readOutput('s-1', 'p-1');
    const output = useBackgroundProcessStore.getState().outputsById.get('p-1');
    expect(output?.cursor).toBe('c2');
    expect(output?.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(output?.hasMore).toBe(true);
  });
});
