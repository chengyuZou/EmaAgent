// 测试后台进程运行时的 15s 转交、取消竞态、停止终态、池分离与断电恢复。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CommandOutputChunk,
  CommandProcessHandle,
  CommandRunnerPort,
  CommandRunResult,
} from '@ema-agent/sandbox';
import { Database, BackgroundProcessesRepo } from '@ema-agent/storage';
import { BackgroundProcessRuntime } from '../background/backgroundProcessRuntime.js';
import type {
  BackgroundCommandRequest,
  BackgroundProcessEvent,
} from '../background/types.js';

const SESSION_ID = '00000000-0000-4000-8000-0000000000a1';
const TURN_ID = '00000000-0000-4000-8000-0000000000b1';
const TOOL_CALL_ID = 'call-1';

// ── 可控假进程 ───────────────────────────────────────────────────────────────

class FakeProcess {
  readonly handle: CommandProcessHandle;
  stopDelayMs = 0;
  stopped = false;
  private readonly resolveCompletion!: (result: CommandRunResult) => void;
  private options?: Parameters<CommandRunnerPort['start']>[1];
  readonly completion: Promise<CommandRunResult>;

  constructor() {
    let resolve!: (result: CommandRunResult) => void;
    this.completion = new Promise(r => { resolve = r; });
    (this as { resolveCompletion: (result: CommandRunResult) => void }).resolveCompletion = resolve;
    this.handle = {
      completion: this.completion,
      stop: () => {
        this.stopped = true;
        this.finishAfter(this.stopDelayMs, killedResult());
      },
    };
  }

  attach(options: Parameters<CommandRunnerPort['start']>[1]): void {
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

class FakeRunner implements CommandRunnerPort {
  readonly processes: FakeProcess[] = [];

  start(_command: string, options?: Parameters<CommandRunnerPort['start']>[1]): CommandProcessHandle {
    const process = new FakeProcess();
    process.attach(options);
    this.processes.push(process);
    return process.handle;
  }

  async run(): Promise<CommandRunResult> {
    return okResult();
  }

  cleanup(): void { /* no-op */ }
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

interface Fixture {
  runtime: BackgroundProcessRuntime;
  runner: FakeRunner;
  events: BackgroundProcessEvent[];
  notified: string[];
  repo: BackgroundProcessesRepo;
  dataDir: string;
  db: Database;
}

function createFixture(options?: {
  maxConcurrent?: number;
  immediateResultWaitMs?: number;
}): Fixture {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-bg-runtime-'));
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  db.sqlite.prepare(
    `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, '', 1, 1)`,
  ).run(SESSION_ID);
  db.sqlite.prepare(
    `INSERT INTO turns (id, session_id, trigger_type, execution_profile, narrative_policy, status, user_input, started_at)
     VALUES (?, ?, 'userMessage', 'work', 'off', 'running', '', 1)`,
  ).run(TURN_ID, SESSION_ID);
  // background_processes.tool_call_id 有归属触发器,必须指向真实 tool_executions.call_id。
  db.sqlite.prepare(
    `INSERT INTO tool_executions (call_id, session_id, turn_id, tool_name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'bash', 'running', 1, 1)`,
  ).run(TOOL_CALL_ID, SESSION_ID, TURN_ID);

  const events: BackgroundProcessEvent[] = [];
  const notified: SessionId[] = [];
  const runner = new FakeRunner();
  const repo = new BackgroundProcessesRepo(db.sqlite);
  const runtime = new BackgroundProcessRuntime({
    store: repo,
    outputPath: (sessionId, processId) => {
      const relativeDirectory = path.join('sessions', sessionId, 'background-processes', processId);
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
    ...(options?.immediateResultWaitMs !== undefined
      ? { immediateResultWaitMs: options.immediateResultWaitMs }
      : {}),
  });
  runtime.setCompletionListener(sessionId => notified.push(sessionId));

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
  return path.join(fixture.dataDir, 'sessions', SESSION_ID, 'background-processes', processId);
}

/** 交互快速路径清理后,进程根目录要么不存在要么为空。 */
function processesRootEmpty(fixture: Fixture): boolean {
  const root = path.join(fixture.dataDir, 'sessions', SESSION_ID, 'background-processes');
  return !fs.existsSync(root) || fs.readdirSync(root).length === 0;
}

/** 交互路径的坑位放行是微任务;等一个宏任务确保已 spawn 再操作假进程。 */
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

function tracked(options?: Parameters<typeof createFixture>[0]): Fixture {
  const fixture = createFixture(options);
  fixtures.push(fixture);
  return fixture;
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe('BackgroundProcessRuntime', () => {
  it('15 秒内完成:返回普通结果,不留 DB 行,日志目录已清理', async () => {
    const fixture = tracked();
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

  it('超过交互等待转交后台:落 running,自然完成后转 completed 并通知,日志保留', async () => {
    const fixture = tracked({ immediateResultWaitMs: 40 });
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
    expect(fixture.notified).toEqual([SESSION_ID]);

    const stdout = fs.readFileSync(
      path.join(logDirFor(fixture, result.backgroundProcessId), 'stdout.log'),
      'utf8',
    );
    expect(stdout).toBe('partial');
  });

  it('计时器胜出但用户已取消:不登记为后台进程,抛取消错误并清理日志', async () => {
    const fixture = tracked({ immediateResultWaitMs: 80 });
    const controller = new AbortController();
    const pending = fixture.runtime.runCommand(makeRequest(fixture, {
      waitSignal: controller.signal,
    }));
    await tick();
    // 进程停止较慢(取消后 100ms 才死),计时器必然先胜出。
    fixture.runner.processes[0]!.stopDelayMs = 100;
    setTimeout(() => controller.abort(new Error('user stop')), 30);

    await expect(pending).rejects.toThrow();
    expect(fixture.repo.listForSession(SESSION_ID)).toHaveLength(0);
    expect(processesRootEmpty(fixture)).toBe(true);
  });

  it('停止运行中的进程:等待退出后返回真实 stopped 终态', async () => {
    const fixture = tracked();
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
    const fixture = tracked({ maxConcurrent: 1 });
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

  it('后台池被长任务占满时,交互命令仍能从独立小池立即执行', async () => {
    const fixture = tracked({ maxConcurrent: 1 });
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    // 长任务永不完成,后台池已满。

    const pending = fixture.runtime.runCommand(makeRequest(fixture));
    await tick();
    fixture.runner.processes[1]!.finishAfter(20, okResult('quick'));
    const result = await pending;

    expect(result.kind).toBe('commandResult');
  });

  it('discardSession 停止进程树并等待退出后才返回', async () => {
    const fixture = tracked({ maxConcurrent: 2 });
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, command: 'b' }));

    await fixture.runtime.discardSession(SESSION_ID);

    expect(fixture.runner.processes.map(p => p.stopped)).toEqual([true, true]);
  });

  it('recoverInterrupted 把 queued 与 running 全部收为 interrupted 并发事件', async () => {
    const fixture = tracked({ maxConcurrent: 1 });
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true }));
    await fixture.runtime.runCommand(makeRequest(fixture, { runInBackground: true, command: 'b' }));

    const summaries = fixture.runtime.recoverInterrupted();

    expect(summaries.map(s => s.status)).toEqual(['interrupted', 'interrupted']);
    expect(fixture.events.filter(e => e.status === 'interrupted')).toHaveLength(2);
  });
});
