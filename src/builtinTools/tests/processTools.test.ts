// 验证 Process 三件套: 窄 Context、Session 身份走 ToolInvocation、端口调用与模型投影。
import { describe, expect, it, vi } from 'vitest';
import {
  asBackgroundProcessId,
  asSessionId,
  asToolCallId,
  asTurnId,
  type BackgroundProcessId,
  type SessionId,
} from '@ema-agent/ids';
import type {
  BackgroundProcessListOptions,
  BackgroundProcessPort,
  BackgroundProcessSummary,
  ToolInvocation,
} from '@ema-agent/tools';
import { ProcessListTool } from '../tools/ProcessListTool/ProcessListTool.js';
import { ProcessOutputTool } from '../tools/ProcessOutputTool/ProcessOutputTool.js';
import { ProcessStopTool } from '../tools/ProcessStopTool/ProcessStopTool.js';

function summary(
  overrides: Partial<BackgroundProcessSummary> = {},
): BackgroundProcessSummary {
  return {
    id: asBackgroundProcessId('00000000-0000-4000-8000-000000000001'),
    sessionId: asSessionId('session-proc'),
    command: 'npm test',
    cwd: 'D:/work',
    status: 'running',
    createdAt: 1,
    durationMs: 1_000,
    stdoutBytes: 10,
    stderrBytes: 0,
    outputTruncated: false,
    outputDir: 'D:/data/logs/x',
    ...overrides,
  };
}

function makePort(): BackgroundProcessPort & {
  list: ReturnType<typeof vi.fn<(sessionId: SessionId, options?: BackgroundProcessListOptions) => BackgroundProcessSummary[]>>;
  readOutput: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    runCommand: vi.fn(),
    list: vi.fn(() => []),
    readOutput: vi.fn(),
    stop: vi.fn(),
  } as unknown as BackgroundProcessPort & {
    list: ReturnType<typeof vi.fn<(sessionId: SessionId, options?: BackgroundProcessListOptions) => BackgroundProcessSummary[]>>;
    readOutput: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
}

function invocation(): ToolInvocation {
  return Object.freeze({
    sessionId: asSessionId('session-proc'),
    turnId: asTurnId('turn-proc'),
    toolCallId: asToolCallId('toolcall-proc'),
    signal: new AbortController().signal,
  });
}

function narrowContext(port: BackgroundProcessPort): { backgroundProcesses: BackgroundProcessPort } {
  const result = ProcessListTool.validateContext({ backgroundProcesses: port } as never);
  if (!result.valid) throw new Error(result.reason);
  return result.context;
}

describe('Process 工具 validateContext', () => {
  it.each([
    ['ProcessList', ProcessListTool],
    ['ProcessOutput', ProcessOutputTool],
    ['ProcessStop', ProcessStopTool],
  ])('%s 没有后台进程端口时拒绝执行', (_name, tool) => {
    expect(tool.validateContext({} as never)).toEqual({
      valid: false,
      reason: '当前执行环境没有后台进程能力。',
    });
  });

  it('有端口时只投影窄 Context', () => {
    const port = makePort();
    const result = ProcessListTool.validateContext({
      backgroundProcesses: port,
    } as never);
    expect(result).toEqual({ valid: true, context: { backgroundProcesses: port } });
  });
});

describe('ProcessListTool', () => {
  it('按 Session 与过滤条件列出进程', async () => {
    const port = makePort();
    port.list.mockReturnValue([
      summary({ status: 'running' }),
      summary({
        id: asBackgroundProcessId('00000000-0000-4000-8000-000000000002'),
        status: 'completed',
        exitCode: 0,
      }),
    ]);
    const input = ProcessListTool.inputSchema.parse({ status: 'running' });

    const result = await ProcessListTool.execute(input, narrowContext(port), invocation());
    expect(result.processes).toHaveLength(2);
    expect(port.list).toHaveBeenCalledWith(
      asSessionId('session-proc'),
      { status: 'running', limit: 20 },
    );

    const content = String(ProcessListTool.mapResultToModelContent!(result));
    expect(content).toContain('[running] npm test');
    expect(content).toContain('[completed] npm test (exit 0)');
  });

  it('空列表投影给出明确提示', async () => {
    const port = makePort();
    port.list.mockReturnValue([]);
    const result = await ProcessListTool.execute(
      ProcessListTool.inputSchema.parse({}),
      narrowContext(port),
      invocation(),
    );
    expect(String(ProcessListTool.mapResultToModelContent!(result)))
      .toBe('当前没有后台进程。');
  });

  it('schema 拒绝未知字段与超限 limit', () => {
    expect(ProcessListTool.inputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ProcessListTool.inputSchema.safeParse({ mode: 'x' }).success).toBe(false);
  });
});

describe('ProcessOutputTool', () => {
  it('按 Session 与游标读取增量输出', async () => {
    const port = makePort();
    const processId = asBackgroundProcessId('00000000-0000-4000-8000-000000000003');
    port.readOutput.mockResolvedValue({
      process: summary({ status: 'running' }),
      stdout: 'hello',
      stderr: '',
      nextCursor: 'cursor-2',
      hasMore: true,
    });
    const input = ProcessOutputTool.inputSchema.parse({
      backgroundProcessId: processId,
      cursor: 'cursor-1',
      waitMs: 500,
    });

    const result = await ProcessOutputTool.execute(input, narrowContext(port), invocation());
    expect(port.readOutput).toHaveBeenCalledWith(
      asSessionId('session-proc'),
      processId,
      { cursor: 'cursor-1', waitMs: 500 },
    );
    const content = String(ProcessOutputTool.mapResultToModelContent!(result));
    expect(content).toContain('[stdout]\nhello');
    expect(content).toContain('nextCursor=cursor-2');
  });

  it('schema 拒绝超限 waitMs', () => {
    expect(ProcessOutputTool.inputSchema.safeParse({
      backgroundProcessId: '00000000-0000-4000-8000-000000000003',
      waitMs: 30_001,
    }).success).toBe(false);
  });
});

describe('ProcessStopTool', () => {
  it('按 Session 停止进程并投影终态', async () => {
    const port = makePort();
    const processId = asBackgroundProcessId('00000000-0000-4000-8000-000000000004');
    port.stop.mockResolvedValue(summary({ status: 'stopped' }));
    const input = ProcessStopTool.inputSchema.parse({
      backgroundProcessId: processId,
    });

    const result = await ProcessStopTool.execute(input, narrowContext(port), invocation());
    expect(port.stop).toHaveBeenCalledWith(asSessionId('session-proc'), processId);
    expect(String(ProcessStopTool.mapResultToModelContent!(result)))
      .toContain('最终状态: stopped');
  });
});
