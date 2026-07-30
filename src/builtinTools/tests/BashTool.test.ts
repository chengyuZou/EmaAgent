// 测试 Bash 只通过受控后台进程入口执行，并公开真实的一次性转后台能力。

import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import { splitToolResult } from '@ema-agent/tools';
import { BashTool } from '../tools/BashTool/BashTool.js';

describe('BashTool 执行边界', () => {
  it('模型可见 Schema 使用真实 runInBackground，不保留旧蛇形字段', () => {
    const properties = BashTool.descriptor().inputJsonSchema['properties'] as
      | Record<string, unknown>
      | undefined;

    expect(properties).toHaveProperty('runInBackground');
    expect(properties).not.toHaveProperty('run_in_background');
  });

  it('没有 CommandRunner 时明确拒绝，不回退到裸进程', () => {
    // 新模式：缺少 commandRunner 时 validateContext 投影失败，execute 不会被调用。
    const projection = BashTool.unsafeValidateContext({
      sessionId: asSessionId('session-test'),
      turnId: asTurnId('turn-test'),
      workspaceRoot: 'D:/workspace',
      signal: new AbortController().signal,
      // commandRunner 刻意不提供，验证工具不会回退到裸进程
    });
    expect(projection.valid).toBe(false);
  });

  it('使用实际执行参数生成命令展示数据', async () => {
    const runCommand = vi.fn().mockResolvedValue({
      kind: 'commandResult',
      result: {
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        truncated: false,
        aborted: false,
      },
      durationMs: 12,
    });
    const projection = BashTool.unsafeValidateContext({
      sessionId: asSessionId('session-presentation'),
      turnId: asTurnId('turn-presentation'),
      toolCallId: asToolCallId('tool-call-presentation'),
      workspaceRoot: 'D:/workspace',
      signal: new AbortController().signal,
      commandRunner: {
        start: vi.fn(),
        run: vi.fn(),
        cleanup: vi.fn(),
      },
      backgroundProcesses: {
        runCommand,
        list: vi.fn(),
        readOutput: vi.fn(),
        stop: vi.fn(),
      },
    });
    if (!projection.valid) throw new Error(projection.reason);

    const result = await BashTool.unsafeExecute(
      { command: 'git status', description: '查看工作区状态' },
      projection.context,
    );
    const split = splitToolResult(result);

    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'git status',
      description: '查看工作区状态',
      cwd: 'D:/workspace',
    }));
    expect(split.modelOutput).toMatchObject({
      kind: 'commandResult',
      stdout: 'ok',
      exitCode: 0,
      durationMs: 12,
    });
    expect(split.presentation).toEqual({
      kind: 'command',
      command: 'git status',
      workingDirectory: 'D:/workspace',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      truncated: false,
    });
  });
});
