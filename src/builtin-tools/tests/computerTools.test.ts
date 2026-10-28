import { describe, expect, it, vi } from 'vitest';
import { ComputerUse, type ComputerCallKind, type ComputerTransport, type NativeControlState, type NativeRequest } from '@ema-agent/computer-use';
import { StreamingToolExecutor, ToolPool, ToolExecutionError } from '@ema-agent/tools';
import { ObserveWindowTool } from '../tools/ObserveWindowTool/observeWindowTool.js';
import { ComputerActionTool } from '../tools/ComputerActionTool/computerActionTool.js';
import { ComputerEndTool } from '../tools/ComputerEndTool/computerEndTool.js';

function fixture() {
  const listeners = new Set<(state: NativeControlState) => void>();
  const emit = (phase: NativeControlState['phase']) => {
    for (const listener of listeners) listener({ controlId: 'startup', phase, reason: 'user_input' });
  };
  const request = vi.fn(async (request: NativeRequest): Promise<unknown> => {
    if (request.method === 'computer.begin') {
      emit('running');
      return { started: true };
    }
    if (request.method === 'computer.observe') {
      return {
        controlId: 'startup', observationId: 'obs',
        window: { id: '42', title: 'Fixture', app: 'fixture', x: 0, y: 0, width: 10, height: 10 },
        width: 10, height: 10, image: '', mimeType: 'image/png', elements: [], truncated: false,
      };
    }
    if (request.method === 'computer.end') {
      emit('ending');
      emit('ended');
      return { ended: true };
    }
    return { status: 'completed', effect: 'possible', message: 'Done.' };
  });
  const transport: ComputerTransport = {
    request,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close: async () => {},
  };
  const computer = new ComputerUse(transport);
  const askPermission = vi.fn(async () => ({ action: 'allow' as const }));
  const executor = () => new StreamingToolExecutor({
    sessionId: 'session-a',
    turnId: 'turn-a',
    abortSignal: new AbortController().signal,
    toolPool: new ToolPool([ObserveWindowTool, ComputerActionTool, ComputerEndTool]),
    permissionContext: {
      mode: 'default', workspaceRoots: [],
      sessionId: 'session-a',
      rules: ['ObserveWindow', 'ComputerAction', 'ComputerEnd'].map(toolName => ({ key: { toolName }, decision: 'ask' as const, from: 'userSettings' as const })),
    },
    askPermission,
    registerComputerToolCall: (call, reject) => {
      const kinds: Record<string, ComputerCallKind> = {
        ObserveWindow: 'observe', ComputerAction: 'action', ComputerEnd: 'end',
      };
      return computer.registerCall('session-a', call.callId, kinds[call.name]!, error => {
        reject(new ToolExecutionError({ effect: error.effect }, error.message, error.code));
      });
    },
    toolContext: {
      cwd: '', platform: 'win32', computerUse: computer,
    },
    publishEvent: () => {},
    wake: () => {},
  });
  const run = async (id: string, name: string, input: unknown) => {
    const current = executor();
    current.addTool(0, id, name, input);
    await current.join();
    return current.takeCompletedResults()[0]!;
  };
  return { computer, request, emit, askPermission, executor, run };
}

describe('电脑工具执行链', () => {
  it('只有首次启动弹 Permission, 同段观察和动作不重复确认, End 不取消后续执行', async () => {
    const f = fixture();
    expect((await f.run('startup', 'ObserveWindow', { windowId: '42' })).isError).toBeFalsy();
    expect((await f.run('observe-again', 'ObserveWindow', { windowId: '42' })).isError).toBeFalsy();
    expect((await f.run('type', 'ComputerAction', { observationId: 'obs', action: { type: 'type', text: 'hello' } })).isError).toBeFalsy();
    expect((await f.run('end', 'ComputerEnd', {})).isError).toBeFalsy();
    expect(f.askPermission).toHaveBeenCalledOnce();
    expect(f.computer.state).toBeNull();
    await f.computer.close();
  });

  it('暂停时新来的电脑 Tool 立即返回结果, 不等继续或结束, 不重开控制', async () => {
    const f = fixture();
    await f.run('startup', 'ObserveWindow', { windowId: '42' });
    f.emit('paused');
    const executor = f.executor();
    executor.addTool(0, 'waiting-action', 'ComputerAction', { observationId: 'obs', action: { type: 'type', text: 'old' } });
    executor.addTool(1, 'queued-observe', 'ObserveWindow', { windowId: '42' });
    await executor.join();
    const results = executor.takeCompletedResults();
    expect(results).toHaveLength(2);
    expect(results.every(result => result.errorCode === 'computer/paused')).toBe(true);
    expect(f.askPermission).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.filter(([request]) => request.method === 'computer.begin')).toHaveLength(1);
    expect(f.request.mock.calls.filter(([request]) => request.method === 'computer.observe')).toHaveLength(1);
    expect(f.request.mock.calls.some(([request]) => request.method === 'computer.act')).toBe(false);
    await f.computer.close();
  });

  it('同批 ObserveWindow 和 ComputerEnd 在首次执行前入队也能结束控制', async () => {
    const f = fixture();
    const executor = f.executor();
    executor.addTool(0, 'startup', 'ObserveWindow', { windowId: '42' });
    executor.addTool(1, 'end', 'ComputerEnd', {});
    await executor.join();
    expect(executor.takeCompletedResults().map(result => result.isError)).toEqual([false, false]);
    expect(f.computer.state).toBeNull();
    expect(f.askPermission).toHaveBeenCalledOnce();
    await f.computer.close();
  });
});
