// BashTool 收口测试: Schema 字段、Context 投影、受控后台执行、
// 交互期 onProgress 流式(含跨 chunk 字符拼接)、30K 命令上限、map 投影。
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import type { ToolInvocation } from '@ema-agent/tools';
import { BashTool, type BashProgress } from '../tools/BashTool/BashTool.js';
import { extractBashCommentLabel } from '../tools/BashTool/commentLabel.js';

function makeInvocation(): ToolInvocation {
  return {
    sessionId: asSessionId('00000000-0000-4000-8000-0000000000c1'),
    turnId: asTurnId('00000000-0000-4000-8000-0000000000c2'),
    toolCallId: asToolCallId('call-bash-1'),
    signal: new AbortController().signal,
  };
}

function makeHost(runCommand: ReturnType<typeof vi.fn>) {
  return {
    host: {
      workspaceRoot: 'D:/workspace',
      commandRunner: { start: vi.fn(), run: vi.fn() },
      backgroundProcesses: { runCommand, list: vi.fn(), readOutput: vi.fn(), stop: vi.fn() },
    },
  };
}

const SUCCESS_RESULT = {
  kind: 'commandResult' as const,
  result: {
    stdout: 'ok', stderr: '', exitCode: 0,
    timedOut: false, truncated: false, aborted: false,
  },
  durationMs: 12,
};

describe('BashTool — Schema 与 Context', () => {
  it('模型可见 Schema 使用 runInBackground, 命令上限 30K', () => {
    const shape = BashTool.inputSchema.shape;
    expect('runInBackground' in shape).toBe(true);
    expect('run_in_background' in shape).toBe(false);
    expect(BashTool.inputSchema.safeParse({ command: 'x'.repeat(30_000) }).success).toBe(true);
    expect(BashTool.inputSchema.safeParse({ command: 'x'.repeat(30_001) }).success).toBe(false);
  });

  it('没有 commandRunner/backgroundProcesses 时投影失败, 不回退裸进程', () => {
    const empty = BashTool.validateContext({ workspaceRoot: 'D:/ws' } as never);
    expect(empty.valid).toBe(false);
    const noWorkspace = BashTool.validateContext({
      workspaceRoot: '',
      commandRunner: {},
      backgroundProcesses: {},
    } as never);
    expect(noWorkspace.valid).toBe(false);
  });
});

describe('BashTool — 执行', () => {
  it('使用实际执行参数返回结构化命令结果', async () => {
    const runCommand = vi.fn().mockResolvedValue(SUCCESS_RESULT);
    const { host } = makeHost(runCommand);
    const projection = BashTool.validateContext(host as never);
    if (!projection.valid) throw new Error('投影应成功');

    const result = await BashTool.execute(
      { command: 'git status', description: '查看工作区状态' },
      projection.context,
      makeInvocation(),
    );

    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'git status',
      description: '查看工作区状态',
      cwd: 'D:/workspace',
    }));
    expect(result).toMatchObject({ kind: 'commandResult', stdout: 'ok', exitCode: 0 });
  });

  it('交互期输出增量经 onProgress 上报, 跨 chunk 的多字节字符不碎', async () => {
    const runCommand = vi.fn().mockImplementation(async (request) => {
      // "中" = E4 B8 AD: 故意拆在两个 chunk 里回调。
      request.onOutput({ stream: 'stdout', data: Buffer.from([0xe4, 0xb8]) });
      request.onOutput({ stream: 'stdout', data: Buffer.from([0xad]) });
      request.onOutput({ stream: 'stderr', data: Buffer.from('warn') });
      return SUCCESS_RESULT;
    });
    const { host } = makeHost(runCommand);
    const projection = BashTool.validateContext(host as never);
    if (!projection.valid) throw new Error('投影应成功');

    const progress: BashProgress[] = [];
    await BashTool.execute(
      { command: 'echo 中' },
      projection.context,
      makeInvocation(),
      (p) => progress.push(p),
    );

    expect(progress).toEqual([
      { stream: 'stdout', text: '中' },
      { stream: 'stderr', text: 'warn' },
    ]);
  });

  it('转交后台时引用带日志路径', async () => {
    const runCommand = vi.fn().mockResolvedValue({
      kind: 'processReference',
      backgroundProcessId: 'bgp-1',
      status: 'running',
      outputPreview: '…',
      outputRelativePath: 'background/session-1/bgp-1',
    });
    const { host } = makeHost(runCommand);
    const projection = BashTool.validateContext(host as never);
    if (!projection.valid) throw new Error('投影应成功');

    const result = await BashTool.execute(
      { command: 'npm run build', runInBackground: true },
      projection.context,
      makeInvocation(),
    );

    expect(result).toMatchObject({
      kind: 'processReference',
      backgroundProcessId: 'bgp-1',
      outputRelativePath: 'background/session-1/bgp-1',
    });
  });
});

describe('BashTool.mapResultToModelContent', () => {
  it('命令结果: stdout/stderr 排版, 空输出给占位', () => {
    expect(BashTool.mapResultToModelContent!({
      kind: 'commandResult', stdout: 'hello\n', stderr: '', exitCode: 0,
      timedOut: false, truncated: false, durationMs: 5, aborted: false,
    })).toBe('hello');
    expect(BashTool.mapResultToModelContent!({
      kind: 'commandResult', stdout: '', stderr: '', exitCode: 0,
      timedOut: false, truncated: false, durationMs: 5, aborted: false,
    })).toBe('(command completed with no output)');
  });

  it('后台引用: 带 id、日志路径与不轮询提示', () => {
    const out = BashTool.mapResultToModelContent!({
      kind: 'processReference', backgroundProcessId: 'bgp-9', status: 'queued',
      outputPreview: '…', outputRelativePath: 'background/s/bgp-9',
    });
    expect(out).toContain('bgp-9');
    expect(out).toContain('background/s/bgp-9');
    expect(out).toContain('notified');
  });
});

describe('extractBashCommentLabel', () => {
  it('提取首行 # 注释, shebang 与无注释返回 undefined', () => {
    expect(extractBashCommentLabel('# 部署到测试环境\nnpm run deploy')).toBe('部署到测试环境');
    expect(extractBashCommentLabel('#!/bin/bash\necho hi')).toBeUndefined();
    expect(extractBashCommentLabel('echo hi')).toBeUndefined();
    expect(extractBashCommentLabel('#')).toBeUndefined();
  });
});
