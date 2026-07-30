// 测试 Bash 结果只返回一次，并在 15 秒后把同一进程、日志和完成通知转交后台。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asSessionId,
  asToolCallId,
  asTurnId,
  type BackgroundProcessId,
} from '@ema-agent/ids';
import type {
  CommandOutputChunk,
  CommandProcessHandle,
  CommandRunResult,
  CommandRunnerPort,
} from '@ema-agent/sandbox';
import {
  BackgroundProcessesRepo,
  Database,
} from '@ema-agent/storage';
import { BackgroundProcessRuntime } from '../background/runtime.js';

const sessionId = asSessionId('00000000-0000-4000-8000-000000000001');
const turnId = asTurnId('00000000-0000-4000-8000-000000000002');
const toolCallId = asToolCallId('00000000-0000-4000-8000-000000000003');

describe('BackgroundProcessRuntime', () => {
  const directories: string[] = [];
  const databases: Database[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const database of databases.splice(0)) database.close();
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('15 秒内完成时只返回普通结果，不留下后台记录和日志', async () => {
    const fixture = createFixture(directories, databases);
    const result = await fixture.runtime.runCommand(
      commandRequest(resolvedRunner({
        stdout: 'ready',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        truncated: false,
        aborted: false,
      })),
    );

    expect(result).toMatchObject({
      kind: 'commandResult',
      result: { stdout: 'ready', exitCode: 0 },
    });
    expect(fixture.runtime.list(sessionId)).toEqual([]);
    expect(
      fs.readdirSync(path.join(fixture.outputRoot, sessionId)),
    ).toEqual([]);
  });

  it('超过 15 秒后转交同一进程，并在自然完成后保留日志和通知', async () => {
    vi.useFakeTimers();
    const fixture = createFixture(directories, databases);
    const process = deferredProcess();
    const listener = vi.fn();
    fixture.runtime.setCompletionListener(listener);

    const pending = fixture.runtime.runCommand(commandRequest(process.runner));
    await vi.advanceTimersByTimeAsync(15_000);
    const reference = await pending;
    expect(reference).toMatchObject({
      kind: 'processReference',
      status: 'running',
    });
    if (reference.kind !== 'processReference') {
      throw new Error('Expected process reference');
    }

    process.emit?.({ stream: 'stdout', data: Buffer.from('phase one\n') });
    process.resolve({
      stdout: 'phase one',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      truncated: false,
      aborted: false,
    });
    await flushPromises();

    expect(process.start).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.list(sessionId)).toEqual([
      expect.objectContaining({
        id: reference.backgroundProcessId,
        status: 'completed',
        stdoutBytes: 10,
        outputTruncated: false,
      }),
    ]);
    expect(listener).toHaveBeenCalledWith(sessionId);

    const output = await fixture.runtime.readOutput(
      sessionId,
      reference.backgroundProcessId,
    );
    expect(output.stdout).toBe('phase one\n');

    const claim = fixture.runtime.claimCompletionBatch(
      sessionId,
      asTurnId('00000000-0000-4000-8000-000000000004'),
    );
    expect(claim).toMatchObject({
      completions: [{
        processId: reference.backgroundProcessId,
        status: 'completed',
        outputPreview: expect.stringContaining('phase one'),
      }],
    });
  });

  it('永久删除 Session 前关闭日志并停止仍在运行的进程树', async () => {
    const fixture = createFixture(directories, databases);
    const process = deferredProcess();
    const result = await fixture.runtime.runCommand({
      ...commandRequest(process.runner),
      runInBackground: true,
    });
    expect(result.kind).toBe('processReference');

    fixture.runtime.discardSession(sessionId);
    expect(process.stop).toHaveBeenCalledTimes(1);
    expect(() => fs.rmSync(
      path.join(fixture.outputRoot, sessionId),
      { recursive: true, force: true },
    )).not.toThrow();

    process.resolve({
      stdout: '',
      stderr: '',
      exitCode: -1,
      timedOut: false,
      truncated: false,
      aborted: true,
    });
    await flushPromises();
  });
});

function createFixture(
  directories: string[],
  databases: Database[],
): {
  runtime: BackgroundProcessRuntime;
  outputRoot: string;
} {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-background-'));
  directories.push(outputRoot);
  const database = new Database({ memory: true, kind: 'data' });
  databases.push(database);
  database.migrate();
  seedExecutionIdentity(database);

  return {
    outputRoot,
    runtime: new BackgroundProcessRuntime({
      repo: new BackgroundProcessesRepo(database.sqlite),
      outputPath: (ownedSessionId, processId) => {
        const relativeDirectory = path.join(ownedSessionId, processId);
        return {
          relativeDirectory,
          absoluteDirectory: path.join(outputRoot, relativeDirectory),
        };
      },
      settings: () => ({ maxConcurrent: 2, maxRuntimeHours: 24 }),
    }),
  };
}

function seedExecutionIdentity(database: Database): void {
  database.sqlite.prepare(
    `INSERT INTO sessions (id, title, created_at, updated_at)
     VALUES (?, 'Background test', 1, 1)`,
  ).run(sessionId);
  database.sqlite.prepare(
    `INSERT INTO turns (
       id, session_id, status, user_input, started_at, trigger_type,
       execution_profile, narrative_policy
     ) VALUES (?, ?, 'running', 'run', 1, 'userMessage', 'work', 'off')`,
  ).run(turnId, sessionId);
  database.sqlite.prepare(
    `INSERT INTO tool_executions (
       call_id, session_id, turn_id, tool_name, input_json, input_digest,
       status, version, created_at, updated_at
     ) VALUES (?, ?, ?, 'Bash', '{}', 'digest', 'running', 0, 1, 1)`,
  ).run(toolCallId, sessionId, turnId);
}

function commandRequest(runner: CommandRunnerPort) {
  return {
    sessionId,
    turnId,
    toolCallId,
    runner,
    command: 'long command',
    description: 'run test process',
    cwd: 'D:/workspace',
    waitSignal: new AbortController().signal,
    isSuccessfulExitCode: (exitCode: number) => exitCode === 0,
  };
}

function resolvedRunner(result: CommandRunResult): CommandRunnerPort {
  return {
    start: vi.fn(() => ({
      completion: Promise.resolve(result),
      stop: vi.fn(),
    })),
    run: vi.fn(),
    cleanup: vi.fn(),
  };
}

function deferredProcess(): {
  runner: CommandRunnerPort;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  resolve: (result: CommandRunResult) => void;
  emit?: (chunk: CommandOutputChunk) => void;
} {
  let resolve!: (result: CommandRunResult) => void;
  let emit: ((chunk: CommandOutputChunk) => void) | undefined;
  const completion = new Promise<CommandRunResult>(finish => {
    resolve = finish;
  });
  const stop = vi.fn();
  const start = vi.fn((
    command: string,
    options: Parameters<CommandRunnerPort['start']>[1],
  ): CommandProcessHandle => {
    void command;
    emit = options.onOutput;
    return { completion, stop };
  });
  return {
    start,
    stop,
    resolve,
    get emit() { return emit; },
    runner: {
      start,
      run: vi.fn(),
      cleanup: vi.fn(),
    },
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}
