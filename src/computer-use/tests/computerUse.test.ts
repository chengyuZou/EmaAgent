import { describe, expect, it, vi } from 'vitest';
import { ComputerUse, type ComputerCallKind } from '../computerUse.js';
import type { ComputerTransport, NativeControlState, NativeRequest } from '../types.js';

function fixture() {
  const listeners = new Set<(state: NativeControlState) => void>();
  const emit = (phase: NativeControlState['phase'], controlId = 'start', reason: NativeControlState['reason'] = 'agent_end') => {
    for (const listener of listeners) listener({ controlId, phase, reason });
  };
  const request = vi.fn(async (request: NativeRequest): Promise<unknown> => {
    switch (request.method) {
      case 'computer.begin':
        emit('running', request.params.controlId, 'started');
        return { started: true };
      case 'computer.observe':
        return {
          controlId: request.params.controlId,
          observationId: 'obs', activationError: null,
          window: { id: '42', title: 'Fixture', app: 'fixture', x: 0, y: 0, width: 10, height: 10 },
          width: 10, height: 10, image: '', mimeType: 'image/png', elements: [], truncated: false,
        };
      case 'computer.act':
        return { status: 'completed', effect: 'possible', message: 'Done.' };
      case 'computer.end':
        emit('ending', request.params.controlId, 'agent_end');
        emit('ended', request.params.controlId, 'agent_end');
        return { ended: true };
      default:
        return [];
    }
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
  const signal = new AbortController().signal;
  const register = (id: string, kind: ComputerCallKind = 'observe') => {
    const reject = vi.fn();
    const dispose = computer.registerCall('session', 'turn', id, kind, reject);
    return { reject, dispose };
  };
  const start = async (id = 'start') => {
    const call = register(id);
    computer.reserve(id);
    await computer.observe(id, '42', signal);
    call.dispose();
  };
  return { computer, request, emit, signal, register, start };
}

describe('ComputerUse', () => {
  it('同批启动和结束一起入队时, End 绑定首次控制并真正结束它', async () => {
    const f = fixture();
    const start = f.register('start');
    const end = f.register('end', 'end');
    f.computer.reserve('start');
    await f.computer.observe('start', '42', f.signal);
    start.dispose();
    expect(await f.computer.end('end', f.signal)).toEqual({ ended: true });
    expect(f.request.mock.calls.filter(([request]) => request.method === 'computer.end')).toHaveLength(1);
    expect(f.computer.state).toBeNull();
    end.dispose();
    await f.computer.close();
  });

  it('正在输入的调用结束后保留 Rust 的部分完成结果, 不伪造未执行', async () => {
    const f = fixture();
    await f.start();
    let finish!: (result: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const call = f.register('action', 'action');
    const pending = f.computer.act('action', 'obs', { type: 'type', text: 'partial' }, f.signal);
    f.emit('ending', 'start', 'user_end');
    expect(call.reject).not.toHaveBeenCalled();
    finish({ status: 'interrupted', effect: 'possible', message: 'Partial input.' });
    await expect(pending).resolves.toMatchObject({ status: 'interrupted', effect: 'possible' });
    call.dispose();
    await f.computer.close();
  });

  it('Rust 在动作开始前报告观察过期时直接返回, 不重复提交或等待', async () => {
    const f = fixture();
    await f.start();
    f.request.mockImplementationOnce(async () => {
      return { status: 'observation_expired', effect: 'none', message: 'Observe again.' };
    });
    const call = f.register('action', 'action');
    await expect(f.computer.act('action', 'obs', { type: 'type', text: 'old' }, f.signal))
      .resolves.toMatchObject({ status: 'observation_expired', effect: 'none' });
    expect(f.request.mock.calls.filter(([request]) => request.method === 'computer.act')).toHaveLength(1);
    call.dispose();
    await f.computer.close();
  });

  it('拒绝启动释放预约并作废同批调用', async () => {
    const f = fixture();
    const start = f.register('start');
    const queued = f.register('queued');
    f.computer.reserve('start');
    start.dispose();
    expect(f.computer.state).toBeNull();
    expect(queued.reject).toHaveBeenCalledWith(expect.objectContaining({ code: 'computer/control_ended' }));
    expect(() => f.computer.reserve('queued')).toThrow('已结束');
    expect(f.request).not.toHaveBeenCalled();
    queued.dispose();
    await f.computer.close();
  });

  it('启动回应尚未收到时结束, 等启动回应后发送结束请求', async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const call = f.register('start');
    f.computer.reserve('start');
    const observing = f.computer.observe('start', '42', f.signal);
    const observed = expect(observing).rejects.toMatchObject({ code: 'computer/control_ended' });
    const ending = f.computer.endSession('session');
    expect(f.computer.state?.phase).toBe('ending');
    finish({ started: true });
    await Promise.all([observed, ending]);
    expect(f.request.mock.calls.map(([request]) => request.method)).toEqual(['computer.begin', 'computer.end']);
    expect(f.computer.state).toBeNull();
    call.dispose();
    await f.computer.close();
  });

  it('用户结束后需新用户回应才能申请重开, 旧调用和旧通知不能影响新控制', async () => {
    const f = fixture();
    await f.start();
    const old = f.register('old', 'action');
    f.emit('ended', 'start', 'user_end');
    const late = f.register('late');
    expect(late.reject).toHaveBeenCalledOnce();
    f.computer.noteUserInput('session');
    expect(() => f.computer.reserve('late')).toThrow('已结束');
    late.dispose();
    await f.start('new-start');
    f.emit('ended', 'start');
    expect(f.computer.state?.controlId).toBe('new-start');
    await expect(f.computer.act('old', 'obs', { type: 'type', text: 'old' }, f.signal))
      .rejects.toMatchObject({ code: 'computer/control_ended' });
    old.dispose();
    await f.computer.close();
  });


  it('另一 Turn 不能接管操控, Turn 收尾只结束自己的操控', async () => {
    const f = fixture();
    await f.start();
    expect(() => f.computer.registerCall('other', 'other-turn', 'call', 'observe', vi.fn())).toThrow('另一个 Turn');
    await f.computer.endTurn('other-turn');
    expect(f.computer.state?.controlId).toBe('start');
    await f.computer.endTurn('turn');
    expect(f.computer.state).toBeNull();
    await f.computer.close();
  });

});
