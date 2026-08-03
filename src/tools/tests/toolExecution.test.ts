// 测试单次 ToolExecution 只解析一次输入，并串起校验、权限、执行与审计。

import type { SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolPool } from '../assembly/toolPool.js';
import { ToolExecution } from '../execution/toolExecution.js';
import { buildTool } from '../Tool/buildTool.js';
import type { ToolExecutionLiveEvent } from '../index.js';

const sessionId = 'session-single-tool' as SessionId;
const turnId = 'turn-single-tool' as TurnId;
const callId = 'call-single-tool' as ToolCallId;

describe('ToolExecution', () => {
  it('让校验、授权和执行共用唯一 Schema 解析结果', async () => {
    const order: string[] = [];
    const immediateEvents: ToolExecutionLiveEvent[] = [];
    const observedInputs: unknown[] = [];
    let parseCount = 0;
    const tool = buildTool({
      id: 'builtin.test',
      name: 'Test',
      description: '执行测试工具',
      inputSchema: z.object({ value: z.number() }).transform((input) => {
        parseCount += 1;
        return { value: input.value + 1 };
      }),
      validateContext: () => {
        order.push('context');
        return { valid: true, context: {} };
      },
      validateInput: (input) => {
        order.push('validate');
        observedInputs.push(input);
        return { valid: true };
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      getPermissionIntent: (input) => {
        observedInputs.push(input);
        return {
          riskLevel: 'low',
          accessType: 'read',
          promptPolicy: 'neverForTrustedBuiltin',
        };
      },
      execute: async (input, _context, _invocation, onProgress) => {
        order.push('execute');
        observedInputs.push(input);
        onProgress?.({ completed: 1, total: 1 });
        return { value: input.value };
      },
    });
    const permissionAuthorize = vi.fn(async (request: { input: unknown }) => {
      order.push('permission');
      observedInputs.push(request.input);
      return { outcome: 'allow' as const, reason: { type: 'workspace' as const } };
    });
    const execution = new ToolExecution(
      {
        sessionId,
        turnId,
        toolPool: new ToolPool([tool]),
        permission: { authorize: permissionAuthorize, clearSession: () => {} },
        permCtx: { mode: 'default' },
        abortSignal: new AbortController().signal,
        toolContext: { workspaceRoot: 'D:/workspace', platform: 'win32' },
        lifecycle: {
          beforeToolUse: async () => { order.push('before'); },
          afterToolUse: async () => { order.push('after'); },
          onToolFailure: async () => { order.push('failure'); },
        },
        toolExecutionJournal: {
          prepare: () => {
            order.push('journal:prepare');
            return { status: 'prepared' } as never;
          },
          authorize: () => { order.push('journal:authorize'); return undefined as never; },
          start: () => { order.push('journal:start'); return undefined as never; },
          succeed: () => { order.push('journal:succeed'); return undefined as never; },
          fail: () => undefined as never,
          cancel: () => undefined as never,
          outcomeUnknown: () => undefined as never,
        },
      },
      { callId, name: 'Test', args: { value: 1 } },
      event => immediateEvents.push(event),
    );

    const firstRun = execution.run();
    expect(execution.run()).toBe(firstRun);
    const completion = await firstRun;

    expect(parseCount).toBe(1);
    expect(order).toEqual([
      'context',
      'validate',
      'journal:prepare',
      'before',
      'permission',
      'journal:authorize',
      'journal:start',
      'execute',
      'journal:succeed',
      'after',
    ]);
    expect(observedInputs).toHaveLength(4);
    expect(observedInputs.every(input => input === observedInputs[0])).toBe(true);
    expect(immediateEvents).toEqual([expect.objectContaining({
      type: 'tool_progress',
      sessionId,
      turnId,
      callId,
      progress: { completed: 1, total: 1 },
    })]);
    expect(completion.result).toEqual(expect.objectContaining({
      toolUseId: callId,
      content: JSON.stringify({ value: 2 }, null, 2),
      isError: false,
    }));
  });

  it('MCP 不能把自己申报成低风险免询问工具', async () => {
    const authorize = vi.fn(async () => ({
      outcome: 'allow' as const,
      reason: { type: 'workspace' as const },
    }));
    const tool = buildTool({
      id: 'mcp.remote.read',
      name: 'mcp__remote__read',
      origin: { kind: 'mcp', serverName: 'remote', serverToolName: 'read' },
      description: '远程工具',
      inputSchema: z.object({}),
      validateContext: () => ({ valid: true, context: {} }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      getPermissionIntent: () => ({
        riskLevel: 'low',
        accessType: 'read',
        promptPolicy: 'neverForTrustedBuiltin',
      }),
      execute: async () => 'ok',
    });
    const execution = new ToolExecution(
      {
        sessionId,
        turnId,
        toolPool: new ToolPool([tool]),
        permission: { authorize, clearSession: () => {} },
        permCtx: { mode: 'default' },
        abortSignal: new AbortController().signal,
        toolContext: { workspaceRoot: 'D:/workspace', platform: 'win32' },
      },
      { callId, name: tool.name, args: {} },
      () => undefined,
    );

    await execution.run();

    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      intent: {
        riskLevel: 'medium',
        accessType: 'execute',
        promptPolicy: 'whenRequired',
      },
    }), undefined);
  });
});
