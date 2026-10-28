import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CommandOutputChunk,
  CommandProcessHandle,
  CommandStarter,
  CommandRunResult,
} from '@ema-agent/sandbox';
import { startProcess } from '@ema-agent/sandbox';
import { Database, BackgroundProcessesRepo } from '@ema-agent/storage';
import { BackgroundProcess } from '../background/backgroundProcess.js';
import type {
  BackgroundCommandRequest,
} from '../background/types.js';
import type { BackgroundProcessEvent } from '../background/events.js';

const SESSION_ID = '00000000-0000-4000-8000-0000000000a1';
const TURN_ID = '00000000-0000-4000-8000-0000000000b1';
const TOOL_CALL_ID = 'call-1';


class FakeProcess {
  readonly handle: CommandProcessHandle;
  stopDelayMs = 0;
  stopped = false;
  private readonly resolveCompletion: (result: CommandRunResult) => void;
  private options?: Parameters<CommandStarter['start']>[1];
  readonly completion: Promise<CommandRunResult>;

  constructor() {
    let resolve!: (result: CommandRunResult) => void;
    this.completion = new Promise(r => { resolve = r; });
    this.resolveCompletion = resolve;
    this.handle = {
      completion: this.completion,
      stop: () => {
        this.stopped = true;
        this.finishAfter(this.stopDelayMs, killedResult());
      },
    };
  }

  attach(options: Parameters<CommandStarter['start']>[1]): void {
    this.options = options;
  }

  emit(text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    const chunk: CommandOutputChunk = { stream, data: new TextEncoder().encode(text) };
    this.options?.onOutput?.(chunk);
  }

  finishWith(result: CommandRunResult): void {
    this.resolveCompletion(result);
  }

  finishAfter(ms: number, result: CommandRunResult): void {
    setTimeout(() => this.resolveCompletion(result), ms);
  }
}

function okResult(stdout = ''): CommandRunResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false, truncated: false, aborted: false };
}

function killedResult(): CommandRunResult {
  return { stdout: '', stderr: '', exitCode: -1, timedOut: false, truncated: false, aborted: true };
}

class FakeRunner {
  readonly processes: FakeProcess[] = [];

  start(_command: string, options: Parameters<CommandStarter['start']>[1]): CommandProcessHandle {
    const process = new FakeProcess();
    process.attach(options);
    this.processes.push(process);
    return process.handle;
  }

}


interface Fixture {
  runtime: BackgroundProcess;
  runner: FakeRunner;
  events: BackgroundProcessEvent[];
  notified: string[];
  repo: BackgroundProcessesRepo;
  dataDir: string;
  db: Database;
}

async function createFixture(options?: {
  maxConcurrent?: number;
  immediateResultWaitMs?: number;
  assertSessionWorkAllowed?: (sessionId: string) => void;
}): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-bg-runtime-'));
  const db = new Database({ memory: true, kind: 'data' });
  await db.migrate();
  db.sqlite.prepare(
    `INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES (?, '', 'D:/work', 1, 1)`,
  ).run(SESSION_ID);
  db.sqlite.prepare(
    `INSERT INTO turns (id, session_id, status, created_at)
     VALUES (?, ?, 'running', 1)`,
  ).run(TURN_ID, SESSION_ID);
  // background_processes.tool_call_id 有归属触发器,必须指向真实 tool_executions.call_id.
  db.sqlite.prepare(
    `INSERT INTO tool_executions (call_id, session_id, turn_id, tool_name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'bash', 'running', 1, 1)`,
  ).run(TOOL_CALL_ID, SESSION_ID, TURN_ID);

  const events: BackgroundProcessEvent[] = [];
  const notified: string[] = [];
  const runner = new FakeRunner();
  const repo = new BackgroundProcessesRepo(db.sqlite);
  const runtime = new BackgroundProcess({
    assertSessionWorkAllowed: options?.assertSessionWorkAllowed ?? vi.fn(),
    store: repo,
    outputPath: (sessionId, processId) => {
      const relativeDirectory = path.join('background-processes', sessionId, processId);
      return {
        absoluteDirectory: path.join(dataDir, relativeDirectory),
        relativeDirectory,
      };
    },
    resolveOutputLocation: (relativeDirectory) => ({
      absoluteDirectory: path.join(dataDir, relativeDirectory),
      relativeDirectory,
    }),
    settings: () => ({
      maxConcurrent: options?.maxConcurrent ?? 2,
      maxRuntimeHours: 24,
    }),
    emit: event => events.push(event),
    onCompletion: (sessionId, processId, status) => {
      notified.push(`${sessionId}:${processId}:${status}`);
    },
    ...(options?.immediateResultWaitMs !== undefined
      ? { immediateResultWaitMs: options.immediateResultWaitMs }
      : {}),
  });
  return { runtime, runner, events, notified, repo, dataDir, db };
}

function makeRequest(fixture: Fixture, overrides: Partial<BackgroundCommandRequest> = {}): BackgroundCommandRequest {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    toolCallId: TOOL_CALL_ID,
    runner: fixture.runner,
    command: 'echo hi',
    cwd: '.',
    waitSignal: new AbortController().signal,
    isSuccessfulExitCode: code => code === 0,
    ...overrides,
  };
}

function logDirFor(fixture: Fixture, processId: string): string {
  return path.join(fixture.dataDir, 'background-processes', SESSION_ID, processId);
}

/** 交互快速路径清理后,进程根目录要么不存在要么为空. */
function processesRootEmpty(fixture: Fixture): boolean {
  const root = path.join(fixture.dataDir, 'background-processes', SESSION_ID);
  return !fs.existsSync(root) || fs.readdirSync(root).length === 0;
}

/** 等待完成回调保存终态和启动下一条排队命令. */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

const fixtures: Array<{ db: Database; dataDir: string }> = [];
beforeEach(() => undefined);
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close();
    fs.rmSync(fixture.dataDir, { recursive: true, force: true });
  }
});

async function tracked(options?: Parameters<typeof createFixture>[0]): Promise<Fixture> {
  const fixture = await createFixture(options);
  fixtures.push(fixture);
  return fixture;
}


describe('BackgroundProcess', () => {
  it('立即启动的后台命令先通知 queued, 再通知 running', async () => {
    const fixture = await tracked();
    const result = await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    expect(result.kind).toBe('processReference');
    expect(fixture.events.map(event => event.status)).toEqual(['queued', 'running']);
    fixture.runner.processes[0]!.finishWith(okResult());
    await tick();
    expect(fixture.events.map(event => event.status)).toEqual(['queued', 'running', 'completed']);
  });

  it('界面进度通知失败不影响日志写入和命令完成', async () => {
    const fixture = await tracked({ immediateResultWaitMs: 40 });
    const onOutput = vi.fn(() => { throw new Error('progress unavailable'); });
    const pending = fixture.runtime.runCommand(makeRequest(fixture, { onOutput }));
    await tick();
    const process = fixture.runner.processes[0]!;
    process.emit('first');
    process.emit('second');
    const reference = await pending;
    if (reference.kind !== 'processReference') throw new Error('missing process reference');
    process.finishWith(okResult('firstsecond'));
    await tick();

    const output = await fixture.runtime.readOutput(SESSION_ID, reference.backgroundProcessId);
    expect(output.stdout).toBe('firstsecond');
    expect(output.process.status).toBe('completed');
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(process.stopped).toBe(false);
  });

  it.each([false, true])('日志写入失败会停止真实进程并报告失败, background=%s', async runInBackground => {
    const fixture = await tracked();
    let completion: Promise<CommandRunResult> | undefined;
    const runner: CommandStarter = {
      start: (_command, options) => {
        const handle = startProcess({
          executable: process.execPath,
          args: ['-e', "process.stdout.write('command-output'); setInterval(() => {}, 1000)"],
          cwd: fixture.dataDir,
          environment: process.env,
        }, options.timeoutMs, options.signal, options.onOutput);
        completion = handle.completion;
        return handle;
      },
    };
    const write = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    try {
      const pending = fixture.runtime.runCommand(makeRequest(fixture, { runner, runInBackground }));
      if (runInBackground) {
        const reference = await pending;
        if (reference.kind !== 'processReference') throw new Error('missing process reference');
        await expect(completion).rejects.toThrow('disk full');
        await tick();
        const output = await fixture.runtime.readOutput(SESSION_ID, reference.backgroundProcessId);
        expect(output.process.status).toBe('failed');
        expect(output.process.terminationReason).toContain('disk full');
      } else {
        await expect(pending).rejects.toThrow('disk full');
      }
      expect(fixture.runtime.hasLiveProcesses()).toBe(false);
    } finally {
      write.mockRestore();
      await fixture.runtime.shutdown();
    }
  });

  it('一条命令停止报错时仍等其他命令退出, 再返回失败', async () => {
    const fixture = await tracked();
    const first = await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    if (first.kind !== 'processReference') throw new Error('missing process reference');
    const secondProcess = fixture.runner.processes[1]!;
    vi.spyOn(secondProcess.handle, 'stop').mockImplementation(() => {
      secondProcess.stopped = true;
    });
    const stop = fixture.runtime.stop.bind(fixture.runtime);
    vi.spyOn(fixture.runtime, 'stop').mockImplementation(async (sessionId, processId) => {
      const summary = await stop(sessionId, processId);
      if (processId === first.backgroundProcessId) throw new Error('停止记录读取失败');
      return summary;
    });
    let finished = false;
    const stopping = fixture.runtime.stopForSession(SESSION_ID).finally(() => { finished = true; });
    const rejected = expect(stopping).rejects.toThrow('停止记录读取失败');
    try {
      await tick();
      expect(finished).toBe(false);
      expect(secondProcess.stopped).toBe(true);
    } finally {
      secondProcess.finishWith(killedResult());
      await rejected;
    }
    expect(fixture.runtime.hasLiveProcesses()).toBe(false);
  });

  it('会话停止同时停止前台,后台和队列, 保留持久命令日志, 不启动排队项', async () => {
    const fixture = await tracked({ maxConcurrent: 1 });
    const background = await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    const queued = await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    const foreground = fixture.runtime.runCommand(makeRequest(fixture));
    await tick();
    expect(fixture.runner.processes).toHaveLength(2);
    for (const process of fixture.runner.processes) process.stopDelayMs = 15;
    const stopping = fixture.runtime.stopForSession(SESSION_ID);
    expect(fixture.runner.processes.every(process => process.stopped)).toBe(true);
    await stopping;
    await foreground;
    expect(fixture.runtime.hasLiveProcesses()).toBe(false);
    expect(fixture.runner.processes).toHaveLength(2);
    if (background.kind !== 'processReference' || queued.kind !== 'processReference') throw new Error('missing process reference');
    expect(fixture.repo.findById(background.backgroundProcessId)?.status).toBe('stopped');
    expect(fixture.repo.findById(queued.backgroundProcessId)?.status).toBe('stopped');
    expect(fs.existsSync(logDirFor(fixture, background.backgroundProcessId))).toBe(true);
  });

  it('会话开始停止后拒绝新普通命令, 已启动命令仍能正常停止', async () => {
    let closed = false;
    const fixture = await tracked({ assertSessionWorkAllowed: () => {
      if (closed) throw new Error('session_stopping');
    } });
    const foreground = fixture.runtime.runCommand(makeRequest(fixture));
    closed = true;
    await expect(fixture.runtime.runCommand(makeRequest(fixture))).rejects.toThrow('session_stopping');
    await fixture.runtime.stopForSession(SESSION_ID);
    await foreground;
    expect(fixture.runner.processes).toHaveLength(1);
    expect(processesRootEmpty(fixture)).toBe(true);
  });

  it('已取消的普通命令不启动进程并清理临时日志', async () => {
    const fixture = await tracked();
    const controller = new AbortController();
    controller.abort();

    await expect(fixture.runtime.runCommand(makeRequest(fixture, {
      waitSignal: controller.signal,
    }))).rejects.toThrow();

    expect(fixture.runner.processes).toHaveLength(0);
    expect(fixture.runtime.hasLiveProcesses()).toBe(false);
    expect(processesRootEmpty(fixture)).toBe(true);
  });

  it('前台等待内完成:返回普通结果,不留 DB 行,日志目录已清理', async () => {
    const fixture = await tracked();
    const pending = fixture.runtime.runCommand(makeRequest(fixture));
    await tick();
    fixture.runner.processes[0]!.finishAfter(20, okResult('hello'));

    const result = await pending;

    expect(result.kind).toBe('commandResult');
    expect(fixture.runner.processes[0]?.stopped).toBe(false);
    const rows = fixture.repo.listForSession(SESSION_ID);
    expect(rows).toHaveLength(0);
    expect(processesRootEmpty(fixture)).toBe(true);
  });

  it('默认等待 180 秒才转后台, 转交后原调用取消不停止进程也不再发送进度', async () => {
    vi.useFakeTimers();
    try {
      const fixture = await tracked();
      const controller = new AbortController();
      const onOutput = vi.fn();
      const settled = vi.fn();
      const pending = fixture.runtime.runCommand(makeRequest(fixture, {
        waitSignal: controller.signal,
        onOutput,
      }));
      void pending.then(settled);
      await vi.advanceTimersByTimeAsync(0);
      const process = fixture.runner.processes[0]!;
      process.emit('before');
      await vi.advanceTimersByTimeAsync(179_999);
      expect(settled).not.toHaveBeenCalled();
      expect(fixture.repo.listForSession(SESSION_ID)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.kind).toBe('processReference');
      expect(fixture.runner.processes).toHaveLength(1);
      controller.abort();
      expect(process.stopped).toBe(false);
      process.emit('after');
      expect(onOutput).toHaveBeenCalledTimes(1);
      process.finishWith(okResult('beforeafter'));
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.notified).toHaveLength(1);
      if (result.kind !== 'processReference') throw new Error('Expected background reference');
      const output = await fixture.runtime.readOutput(SESSION_ID, result.backgroundProcessId);
      expect(output.stdout).toBe('beforeafter');
      expect(output.process.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('总超时默认读取设置, 显式更短值有效而更长值不能超过设置', async () => {
    const fixture = await tracked();
    const start = vi.spyOn(fixture.runner, 'start');
    for (const timeoutMs of [undefined, 240_000, 7 * 24 * 60 * 60 * 1_000]) {
      await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, timeoutMs }));
    }
    expect(start.mock.calls[0]?.[1].timeoutMs).toBe(24 * 60 * 60 * 1_000);
    expect(start.mock.calls[1]?.[1].timeoutMs).toBe(240_000);
    fixture.runner.processes[0]!.finishWith(okResult());
    await tick();
    expect(start.mock.calls[2]?.[1].timeoutMs).toBe(24 * 60 * 60 * 1_000);
    await fixture.runtime.shutdown();
  });

  it('超过交互等待转交后台:落 running,自然完成后转 completed 并通知,日志保留', async () => {
    const fixture = await tracked({ immediateResultWaitMs: 40 });
    const pending = fixture.runtime.runCommand(makeRequest(fixture));
    await tick();
    const process = fixture.runner.processes[0]!;
    process.emit('partial');
    process.finishAfter(80, okResult('done'));

    const result = await pending;
    expect(result.kind).toBe('processReference');
    if (result.kind !== 'processReference') return;

    const during = fixture.repo.findById(result.backgroundProcessId);
    expect(during?.status).toBe('running');

    await new Promise(resolve => setTimeout(resolve, 150));
    const terminal = fixture.repo.findById(result.backgroundProcessId);
    expect(terminal?.status).toBe('completed');
    expect(fixture.notified).toEqual([
      `${SESSION_ID}:${result.backgroundProcessId}:completed`,
    ]);

    const stdout = fs.readFileSync(
      path.join(logDirFor(fixture, result.backgroundProcessId), 'stdout.log'),
      'utf8',
    );
    expect(stdout).toBe('partial');
  });

  it('计时器胜出但用户已取消:不登记为后台进程,抛取消错误并清理日志', async () => {
    const fixture = await tracked({ immediateResultWaitMs: 80 });
    const controller = new AbortController();
    const pending = fixture.runtime.runCommand(makeRequest(fixture, {
      waitSignal: controller.signal,
    }));
    await tick();
    // 进程停止较慢(取消后 100ms 才死),计时器必然先胜出.
    fixture.runner.processes[0]!.stopDelayMs = 100;
    setTimeout(() => controller.abort(new Error('user stop')), 30);

    await expect(pending).rejects.toThrow();
    expect(fixture.repo.listForSession(SESSION_ID)).toHaveLength(0);
    expect(processesRootEmpty(fixture)).toBe(true);
  });

  it('停止运行中的进程:等待退出后返回真实 stopped 终态', async () => {
    const fixture = await tracked();
    const started = await fixture.runtime.runCommand(makeRequest(fixture, {
      runInBackground: true,
    }));
    expect(started.kind).toBe('processReference');
    if (started.kind !== 'processReference') return;

    const summary = await fixture.runtime.stop(SESSION_ID, started.backgroundProcessId);

    expect(summary.status).toBe('stopped');
    expect(fixture.repo.findById(started.backgroundProcessId)?.status).toBe('stopped');
  });

  it('停止排队中的进程:从未 spawn,直接落 stopped', async () => {
    const fixture = await tracked({ maxConcurrent: 1 });
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    const second = await fixture.runtime.runCommand(makeRequest(fixture, {
      runInBackground: true,
      command: 'sleep 999',
    }));
    expect(second.kind).toBe('processReference');
    if (second.kind !== 'processReference') return;
    expect(second.status).toBe('queued');

    const summary = await fixture.runtime.stop(SESSION_ID, second.backgroundProcessId);

    expect(summary.status).toBe('stopped');
    expect(fixture.runner.processes).toHaveLength(1);
  });

  it('显式后台队列满额时, 超过四条普通命令也直接启动', async () => {
    const fixture = await tracked({ maxConcurrent: 1 });
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    const queued = await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    if (queued.kind !== 'processReference') throw new Error('missing process reference');

    const pending = Array.from({ length: 6 }, () => fixture.runtime.runCommand(makeRequest(fixture)));
    expect(fixture.runner.processes).toHaveLength(7);
    for (const process of fixture.runner.processes.slice(1)) {
      process.finishWith(okResult('quick'));
    }
    const results = await Promise.all(pending);

    expect(results.every(result => result.kind === 'commandResult')).toBe(true);
    expect(fixture.repo.findById(queued.backgroundProcessId)?.status).toBe('queued');
    expect(fixture.runner.processes).toHaveLength(7);
    await fixture.runtime.shutdown();
  });

  it('跨 Session 的显式后台命令按提交顺序启动', async () => {
    const fixture = await tracked({ maxConcurrent: 1 });
    const otherSessionId = 'session-b';
    const otherTurnId = 'turn-b';
    const otherToolCallId = 'call-b';
    fixture.db.sqlite.prepare(
      "INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES (?, '', 'D:/work', 1, 1)",
    ).run(otherSessionId);
    fixture.db.sqlite.prepare(
      "INSERT INTO turns (id, session_id, status, created_at) VALUES (?, ?, 'running', 1)",
    ).run(otherTurnId, otherSessionId);
    fixture.db.sqlite.prepare(
      `INSERT INTO tool_executions (call_id, session_id, turn_id, tool_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'bash', 'running', 1, 1)`,
    ).run(otherToolCallId, otherSessionId, otherTurnId);
    const start = vi.spyOn(fixture.runner, 'start');

    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, command: 'running' }));
    for (const command of ['a1', 'a2', 'a3']) {
      await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, command }));
    }
    await fixture.runtime.runCommand(makeRequest(fixture, {
      runInBackground: true,
      command: 'b1',
      sessionId: otherSessionId,
      turnId: otherTurnId,
      toolCallId: otherToolCallId,
    }));

    for (const command of ['a1', 'a2', 'a3', 'b1']) {
      fixture.runner.processes.at(-1)!.finishWith(okResult());
      await tick();
      expect(start.mock.lastCall?.[0]).toBe(command);
    }
    expect(start.mock.calls.map(([command]) => command)).toEqual(['running', 'a1', 'a2', 'a3', 'b1']);
    await fixture.runtime.shutdown();
  });

  it('普通命令转后台及结束不占用或释放显式后台名额', async () => {
    const fixture = await tracked({ maxConcurrent: 1, immediateResultWaitMs: 10 });
    const foreground = fixture.runtime.runCommand(makeRequest(fixture));
    const process = fixture.runner.processes[0]!;
    const transferred = await foreground;
    expect(transferred.kind).toBe('processReference');

    const background = await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    const queued = await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    if (background.kind !== 'processReference' || queued.kind !== 'processReference') {
      throw new Error('missing process reference');
    }
    expect(background.status).toBe('running');
    expect(queued.status).toBe('queued');
    expect(fixture.runner.processes).toHaveLength(2);

    process.finishWith(okResult());
    await tick();
    expect(fixture.runner.processes).toHaveLength(2);
    expect(fixture.repo.findById(queued.backgroundProcessId)?.status).toBe('queued');

    fixture.runner.processes[1]!.finishWith(okResult());
    await tick();
    expect(fixture.runner.processes).toHaveLength(3);
    expect(fixture.repo.findById(queued.backgroundProcessId)?.status).toBe('running');
    await fixture.runtime.shutdown();
  });

  it('取消排队项不释放运行名额, 后续项保持提交顺序', async () => {
    const fixture = await tracked({ maxConcurrent: 1 });
    const start = vi.spyOn(fixture.runner, 'start');
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, command: 'running' }));
    const cancelled = await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, command: 'cancelled' }));
    if (cancelled.kind !== 'processReference') throw new Error('missing process reference');
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, command: 'next' }));

    await fixture.runtime.stop(SESSION_ID, cancelled.backgroundProcessId);
    expect(start).toHaveBeenCalledTimes(1);
    fixture.runner.processes[0]!.finishWith(okResult());
    await tick();

    expect(start.mock.calls.map(([command]) => command)).toEqual(['running', 'next']);
    expect(fixture.repo.findById(cancelled.backgroundProcessId)?.status).toBe('stopped');
    await fixture.runtime.shutdown();
  });

  it('排队命令启动失败后释放名额并继续启动下一项', async () => {
    const fixture = await tracked({ maxConcurrent: 1 });
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, command: 'running' }));
    const failed = await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, command: 'failed' }));
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, command: 'next' }));
    if (failed.kind !== 'processReference') throw new Error('missing process reference');
    const start = vi.spyOn(fixture.runner, 'start').mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    fixture.runner.processes[0]!.finishWith(okResult());
    await tick();

    expect(start.mock.calls.map(([command]) => command)).toEqual(['failed', 'next']);
    expect(fixture.repo.findById(failed.backgroundProcessId)?.status).toBe('failed');
    expect(fixture.repo.findById(failed.backgroundProcessId)?.terminationReason).toBe('spawn failed');
    await fixture.runtime.shutdown();
  });

  it('discardSession 停止进程树并等待退出后才返回', async () => {
    const fixture = await tracked({ maxConcurrent: 2 });
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, command: 'b' }));

    await fixture.runtime.discardSession(SESSION_ID);

    expect(fixture.runner.processes.map(p => p.stopped)).toEqual([true, true]);
  });

  it('recoverInterrupted 把 queued 与 running 全部收为 interrupted 并发事件', async () => {
    const fixture = await tracked({ maxConcurrent: 1 });
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, command: 'b' }));

    const summaries = fixture.runtime.recoverInterrupted();

    expect(summaries.map(s => s.status)).toEqual(['interrupted', 'interrupted']);
    expect(fixture.events.filter(e => e.status === 'interrupted')).toHaveLength(2);
  });
});
