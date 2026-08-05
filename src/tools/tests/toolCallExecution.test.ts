// 测试单次 Tool 调用管线:查找、Schema、Context、业务校验、权限、执行与取消语义。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import type { PermissionAuthorizer, PermissionIntent, PermissionDecision } from '@ema-agent/permission';
import {
  buildTool,
  contextOk,
  ToolPool,
  type Tool,
  type ToolExecutionEvent,
  type ToolExecutionStatePort,
} from '../index.js';
import {
  ToolCallExecution,
  type ToolExecutionEnvironment,
  type ToolExecutionLiveEvent,
} from '../execution/toolCallExecution.js';

const SESSION_ID = asSessionId('00000000-0000-4000-8000-0000000000a1');
const TURN_ID = asTurnId('00000000-0000-4000-8000-0000000000b1');

const ALLOW: PermissionDecision = { outcome: 'allow', reason: { type: 'mode', mode: 'default' } };

function allowAllPermission(): PermissionAuthorizer & { intents: PermissionIntent[] } {
  const intents: PermissionIntent[] = [];
  return {
    intents,
    authorize: async (request) => {
      intents.push(request.intent);
      return ALLOW;
    },
    clearSession: () => undefined,
  };
}

function denyPermission(): PermissionAuthorizer {
  return {
    authorize: async () => ({
      outcome: 'deny',
      message: '用户拒绝了本次操作',
      reason: { type: 'user', action: 'deny' },
    }),
    clearSession: () => undefined,
  };
}

/** 记录状态迁移顺序的假审计端口。 */
function fakeState() {
  const transitions: string[] = [];
  const record = (status: string) => {
    transitions.push(status);
    return { status } as never;
  };
  const port: ToolExecutionStatePort = {
    prepare: () => record('prepared'),
    authorize: () => record('authorized'),
    start: () => record('running'),
    succeed: () => record('succeeded'),
    fail: () => record('failed'),
    cancel: () => record('cancelled'),
    outcomeUnknown: () => record('outcome_unknown'),
    completeFromMessage: () => record('completeFromMessage'),
  };
  return { port, transitions };
}

type EchoInput = { value: number };
type AnyTestTool = Tool<EchoInput, unknown, Record<string, never>, never>;

function echoTool(overrides: Partial<Parameters<typeof buildTool>[0]> = {}): AnyTestTool {
  return buildTool({
    name: 'Echo',
    description: 'echo',
    inputSchema: z.object({ value: z.number() }),
    validateContext: () => contextOk({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    getPermissionIntent: () => ({
      riskLevel: 'low',
      accessType: 'read',
      promptPolicy: 'whenRequired',
    }),
    execute: async (input: EchoInput) => ({ echoed: input.value }),
    ...overrides,
  }) as AnyTestTool;
}

function makeEnv(options: {
  tools: AnyTestTool[];
  permission?: PermissionAuthorizer;
  state?: ToolExecutionStatePort;
}): ToolExecutionEnvironment {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    abortSignal: new AbortController().signal,
    toolPool: new ToolPool(options.tools as never),
    permission: options.permission ?? allowAllPermission(),
    permissionContext: { mode: 'default' },
    toolContext: { workspaceRoot: '', platform: process.platform },
    ...(options.state ? { toolExecutionState: options.state } : {}),
  };
}

function makeCall(env: ToolExecutionEnvironment, name: string, args: unknown): {
  execution: ToolCallExecution;
  events: ToolExecutionLiveEvent[];
} {
  const events: ToolExecutionLiveEvent[] = [];
  const execution = new ToolCallExecution(
    env,
    { callId: asToolCallId('call-1'), name, args },
    event => events.push(event),
  );
  return { execution, events };
}

describe('ToolCallExecution', () => {
  it('模型幻觉不存在的工具名 → tool/unavailable,不产生状态迁移', async () => {
    const state = fakeState();
    const { execution } = makeCall(makeEnv({ tools: [], state: state.port }), 'Ghost', {});

    const { result } = await execution.run();

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe('tool/unavailable');
    expect(state.transitions).toHaveLength(0);
  });

  it('Schema 解析失败 → tool/validation_failed', async () => {
    const { execution } = makeCall(makeEnv({ tools: [echoTool()] }), 'Echo', { value: 'x' });

    const { result } = await execution.run();

    expect(result.errorCode).toBe('tool/validation_failed');
  });

  it('validateContext 失败 → tool/context_unavailable', async () => {
    const tool = echoTool({
      validateContext: () => ({ valid: false as const, reason: '没有工作区' }),
    });
    const { execution } = makeCall(makeEnv({ tools: [tool] }), 'Echo', { value: 1 });

    const { result } = await execution.run();

    expect(result.errorCode).toBe('tool/context_unavailable');
  });

  it('validateInput 失败 → 业务错误码,不进入权限阶段', async () => {
    const permission = allowAllPermission();
    const tool = echoTool({
      validateInput: () => ({ valid: false as const, message: '已存在', code: 'file/exists' }),
    });
    const state = fakeState();
    const { execution } = makeCall(
      makeEnv({ tools: [tool], permission, state: state.port }),
      'Echo',
      { value: 1 },
    );

    const { result } = await execution.run();

    expect(result.errorCode).toBe('file/exists');
    expect(permission.intents).toHaveLength(0);
  });

  it('权限拒绝 → permission/denied,不越过 running 边界', async () => {
    const state = fakeState();
    const { execution } = makeCall(
      makeEnv({ tools: [echoTool()], permission: denyPermission(), state: state.port }),
      'Echo',
      { value: 1 },
    );

    const { result } = await execution.run();

    expect(result.errorCode).toBe('permission/denied');
    expect(state.transitions).toEqual(['prepared']);
  });

  it('成功执行:结果规范化、终态事件齐备、commitResult 后落 succeeded', async () => {
    const state = fakeState();
    const { execution, events } = makeCall(
      makeEnv({ tools: [echoTool()], state: state.port }),
      'Echo',
      { value: 42 },
    );

    const { result, terminalEvent } = await execution.run();
    execution.commitResult();

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ echoed: 42 });
    expect(terminalEvent.type).toBe('tool_result');
    expect(state.transitions).toEqual(['prepared', 'authorized', 'running', 'succeeded']);
    expect(events.some(e => e.type === 'tool_result')).toBe(false);
  });

  it('执行中被用户取消:终态是 cancelled 而不是 succeeded(回归)', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tool = echoTool({
      execute: async () => {
        await gate;
        throw new DOMException('The operation was aborted', 'AbortError');
      },
    });
    const state = fakeState();
    const { execution } = makeCall(
      makeEnv({ tools: [tool], state: state.port }),
      'Echo',
      { value: 1 },
    );

    const pending = execution.run();
    execution.abort();
    release();
    const { result, terminalEvent } = await pending;
    execution.commitResult();

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe('tool/cancelled');
    // 模型看到的是取消;审计按 outcome_unknown 关账——running 后的取消无法证明干净。
    expect(state.transitions).toEqual(['prepared', 'authorized', 'running', 'outcome_unknown']);
    expect(state.transitions).not.toContain('succeeded');
    expect(state.transitions).not.toContain('cancelled');
    expect(terminalEvent).toMatchObject({
      error: { code: 'tool/cancelled' },
    });
  });

  it('MCP 工具申报的意图被强制加固:风险不低于 medium、execute、必询问', async () => {
    const permission = allowAllPermission();
    const tool = echoTool({
      origin: { kind: 'mcp', serverName: 'srv', serverToolName: 'echo' },
      getPermissionIntent: () => ({
        riskLevel: 'low',
        accessType: 'read',
        promptPolicy: 'neverForTrustedBuiltin',
      }),
    });
    const { execution } = makeCall(
      makeEnv({ tools: [tool], permission }),
      'Echo',
      { value: 1 },
    );

    await execution.run();

    expect(permission.intents).toEqual([{
      riskLevel: 'medium',
      accessType: 'execute',
      promptPolicy: 'whenRequired',
    }]);
  });
});
