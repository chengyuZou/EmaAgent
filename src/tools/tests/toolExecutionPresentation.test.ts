// 测试工具的客户端展示数据会进入执行事件和结果块，但不会混进模型看到的正文。
import { describe, expect, it } from 'vitest';
import type { SessionId, TurnId } from '@ema-agent/ids';
import {
  presentToolResult,
  ToolExecutionRuntime,
  type ToolExecutionRuntimeEvent,
} from '../index.js';

const sessionId = 'session-presentation' as SessionId;
const turnId = 'turn-presentation' as TurnId;

describe('tool presentation flow', () => {
  it('把真实 diff 发给客户端并保持模型结果简短', async () => {
    const emitted: ToolExecutionRuntimeEvent[] = [];
    let journalOutput: unknown;
    const executor = new ToolExecutionRuntime({
      sessionId,
      turnId,
      allows: () => true,
      tools: {
        has: () => true,
        prepare: (name: string, input: unknown) => ({
          id: 'builtin.file.edit',
          name,
          input,
          isReadOnly: false,
          isConcurrencySafe: false,
          permissionMeta: {},
        }),
        execute: async () => presentToolResult(
          { filePath: 'demo.txt', replacements: 1 },
          {
            kind: 'file_change',
            operation: 'update',
            filePath: 'demo.txt',
            unifiedDiff: '--- a/demo.txt\n+++ b/demo.txt\n-old\n+new\n',
            additions: 1,
            deletions: 1,
            truncated: false,
          },
        ),
      } as never,
      permission: { gate: async () => ({ granted: true }) } as never,
      permCtx: { workspaceRoot: '', sessionId } as never,
      toolCtx: {
        sessionId,
        turnId,
        workspaceRoot: '',
        signal: new AbortController().signal,
        readFileState: new Map(),
      },
      pushEv: event => emitted.push(event),
      signal: () => undefined,
      toolExecutionJournal: {
        prepare: () => undefined,
        authorize: () => undefined,
        start: () => undefined,
        succeed: (_callId, output) => { journalOutput = output; },
        fail: () => undefined,
        cancel: () => undefined,
        outcomeUnknown: () => undefined,
      },
    });

    executor.addTool(0, 'call-presentation', 'Edit', { file_path: 'demo.txt' });
    await waitUntilDone(executor);

    expect(journalOutput).toEqual({ filePath: 'demo.txt', replacements: 1 });
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      output: { filePath: 'demo.txt', replacements: 1 },
      presentation: expect.objectContaining({ kind: 'file_change', additions: 1, deletions: 1 }),
    }));
    expect(executor.getResults()[0]).toEqual(expect.objectContaining({
      content: JSON.stringify({ filePath: 'demo.txt', replacements: 1 }, null, 2),
      presentation: expect.objectContaining({ kind: 'file_change' }),
    }));
  });
});

async function waitUntilDone(executor: ToolExecutionRuntime): Promise<void> {
  while (!executor.allDone()) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}
