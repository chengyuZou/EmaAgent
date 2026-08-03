// 测试单调用 ToolExecution 独占准备、校验、审批、执行、审计与终态结果。

import { describe, expect, it, vi } from 'vitest';
import type { SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import {
  createToolManifestSnapshot,
  ToolExecution,
  type ExecutableToolManifestSnapshot,
  type ToolExecutionLiveEvent,
} from '../index.js';

const sessionId = 'session-single-tool' as SessionId;
const turnId = 'turn-single-tool' as TurnId;
const callId = 'call-single-tool' as ToolCallId;

describe('ToolExecution', () => {
  it('通过唯一单调用入口完成完整执行流水线并把终态交给调度器', async () => {
    const order: string[] = [];
    const immediateEvents: ToolExecutionLiveEvent[] = [];
    const manifest = createToolManifestSnapshot([], 1) as ExecutableToolManifestSnapshot;
    const tools = {
      prepare: () => {
        order.push('prepare');
        return {
          id: 'builtin.test',
          name: 'Test',
          origin: { kind: 'builtin' as const },
          input: { value: 1 },
          isReadOnly: true,
          isConcurrencySafe: true,
          requiresUserInteraction: false,
          maxResultBytes: 1024,
        };
      },
      validateContext: () => {
        order.push('context');
        return { valid: true as const, context: {} };
      },
      validate: async () => {
        order.push('validate');
        return { valid: true as const };
      },
      permissionIntent: async () => ({
        riskLevel: 'low' as const,
        accessType: 'read' as const,
        promptPolicy: 'neverForTrustedBuiltin' as const,
      }),
      execute: async () => {
        order.push('execute');
        return { ok: true };
      },
    };
    const permissionAuthorize = vi.fn(async () => {
      order.push('permission');
      return { outcome: 'allow' as const, reason: { type: 'workspace' as const } };
    });
    const execution = new ToolExecution(
      {
        sessionId,
        turnId,
        allows: () => true,
        toolManifest: manifest,
        tools: tools as never,
        permission: { authorize: permissionAuthorize, clearSession: () => {} },
        permCtx: { mode: 'default' },
        toolContext: { signal: new AbortController().signal },
        lifecycle: {
          beforeToolUse: async () => { order.push('before'); },
          afterToolUse: async () => { order.push('after'); },
          onToolFailure: async () => { order.push('failure'); },
        },
        toolExecutionJournal: {
          prepare: () => { order.push('journal:prepare'); return undefined as never; },
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
    const secondRun = execution.run();
    expect(secondRun).toBe(firstRun);
    const completion = await firstRun;

    expect(order).toEqual([
      'prepare',
      'journal:prepare',
      'before',
      'context',
      'validate',
      'permission',
      'journal:authorize',
      'journal:start',
      'execute',
      'journal:succeed',
      'after',
    ]);
    expect(immediateEvents).toEqual([]);
    expect(completion.result).toEqual(expect.objectContaining({
      toolUseId: callId,
      content: JSON.stringify({ ok: true }, null, 2),
      isError: false,
    }));
    expect(completion.terminalEvent).toEqual(expect.objectContaining({
      type: 'tool_result',
      callId,
      output: { ok: true },
    }));
  });
});
