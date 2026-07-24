// 测试 Bash 只通过受控 CommandRunner 执行，并且不再向模型声明假后台能力。

import { describe, expect, it } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import { BashTool } from '../tools/BashTool/BashTool.js';

describe('BashTool 执行边界', () => {
  it('模型可见 Schema 不再包含 run_in_background', () => {
    const properties = BashTool.descriptor().inputJsonSchema['properties'] as
      | Record<string, unknown>
      | undefined;

    expect(properties).not.toHaveProperty('run_in_background');
  });

  it('没有 CommandRunner 时明确拒绝，不回退到裸进程', async () => {
    await expect(BashTool.execute(
      { command: 'echo should-not-run' },
      {
        sessionId: asSessionId('session-test'),
        turnId: asTurnId('turn-test'),
        toolCallId: asToolCallId('bash-test-call'),
        workspaceRoot: 'D:/workspace',
        signal: new AbortController().signal,
      },
      { readFileState: new Map() },
    )).rejects.toThrow('没有可用的受控命令执行器');
  });
});
