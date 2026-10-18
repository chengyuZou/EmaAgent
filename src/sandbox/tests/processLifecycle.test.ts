import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startProcess } from '../process/processRunner.js';

const boundary = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => boundary);

function childProcess(pid: number | undefined) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

const command = {
  executable: 'bash',
  args: ['-c', 'echo hello'],
  cwd: process.cwd(),
  environment: {},
};

beforeEach(() => {
  boundary.spawn.mockReset();
  boundary.spawnSync.mockReset();
  vi.spyOn(process, 'kill').mockReturnValue(true);
});

afterEach(() => vi.restoreAllMocks());

function expectNoTermination(): void {
  expect(boundary.spawnSync).not.toHaveBeenCalled();
  expect(process.kill).not.toHaveBeenCalled();
}

describe('process handle lifetime', () => {
  it('stop after completion does not target a process ID that may have been reused', async () => {
    const child = childProcess(654321);
    boundary.spawn.mockReturnValue(child);
    const handle = startProcess(command, 5_000);
    child.emit('close', 0);
    await handle.completion;

    handle.stop();
    handle.stop();

    expectNoTermination();
  });

  it('stop after a spawn error does not send a termination request', async () => {
    const child = childProcess(undefined);
    boundary.spawn.mockReturnValue(child);
    const handle = startProcess(command, 5_000);
    const failure = expect(handle.completion).rejects.toThrow('spawn failed');
    child.emit('error', new Error('spawn failed'));
    await failure;

    handle.stop();

    expectNoTermination();
  });

  it('output storage failure terminates execution and rejects only after close', async () => {
    const child = childProcess(654321);
    boundary.spawn.mockReturnValue(child);
    const onOutput = vi.fn(() => { throw new Error('disk full'); });
    const handle = startProcess(command, 5_000, undefined, onOutput);
    const failure = expect(handle.completion).rejects.toThrow('disk full');
    let finished = false;
    void handle.completion.then(() => { finished = true; }, () => { finished = true; });

    child.stdout.emit('data', Buffer.from('first'));
    await Promise.resolve();
    expect(finished).toBe(false);
    if (process.platform === 'win32') {
      expect(boundary.spawnSync).toHaveBeenCalledWith('taskkill', expect.any(Array), expect.any(Object));
    } else {
      expect(process.kill).toHaveBeenCalledWith(-child.pid!, 'SIGTERM');
    }
    child.stderr.emit('data', Buffer.from('last'));
    child.emit('close', 0);

    await failure;
    expect(onOutput).toHaveBeenCalledTimes(1);
  });
});
