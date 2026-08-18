// 测试单次 Tool 调用管线:查找、Schema、Context、业务校验、权限、执行与取消语义。
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  PermissionRequest,
  ToolPermissionContext,
} from '@ema-agent/permission';
import {
  buildTool,
  contextOk,
  ToolExecutionState,
  ToolPool,
  type Tool,
  type ToolExecutionEvent,
  type ToolExecutionRecord,
  type ToolExecutionStateStore,
  type ToolExecutionStatus,
} from '../index.js';
import {
  ToolCallExecution,
  type ToolExecutionEnvironment,
} from '../execution/toolCallExecution.js';

const SESSION_ID = '00000000-0000-4000-8000-0000000000a1';
const TURN_ID = '00000000-0000-4000-8000-0000000000b1';

const PERMISSION_CONTEXT: ToolPermissionContext = {
  mode: 'default',
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
};

/** 内存版原子存储:与 SQL 实现同语义(version CAS + from 集合)。 */
class InMemoryStore implements ToolExecutionStateStore {
  private readonly rows = new Map<string, ToolExecutionRecord>();

  insertPrepared(value: Parameters<ToolExecutionStateStore['insertPrepared']>[0]) {
    if (this.rows.has(value.callId)) return undefined;
    const record: ToolExecutionRecord = {
      ...value,
      status: 'prepared',
      version: 0,
      updatedAt: value.createdAt,
    };
    this.rows.set(value.callId, record);
    return record;
  }

  findByCallId(callId: Parameters<ToolExecutionStateStore['findByCallId']>[0]) {
    return this.rows.get(callId);
  }

  listForTurn(turnId: string) {
    return [...this.rows.values()].filter(row => row.turnId === turnId);
  }

  transition(
    callId: Parameters<ToolExecutionStateStore['transition']>[0],
    expectedVersion: number,
    from: readonly ToolExecutionStatus[],
    to: ToolExecutionStatus,
    at: number,
    terminal?: { completedAt: number },
  ) {
    const row = this.rows.get(callId);
    if (!row || row.version !== expectedVersion || !from.includes(row.status)) return undefined;
    const updated: ToolExecutionRecord = {
      ...row,
      status: to,
      version: row.version + 1,
      updatedAt: at,
      ...(to === 'running' && row.startedAt === undefined ? { startedAt: at } : {}),
      ...(terminal ? { completedAt: terminal.completedAt } : {}),
    };
    this.rows.set(callId, updated);
    return updated;
  }

  listInterrupted() {
    return [...this.rows.values()].filter(
      row => row.status === 'prepared' || row.status === 'authorized' || row.status === 'running',
    );
  }
}

/** 真实状态机 + 内存 store;测试直接断言持久记录而非迁移录音。 */
function makeState() {
  const store = new InMemoryStore();
  return { state: new ToolExecutionState(store), store };
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
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    execute: async (input: EchoInput) => ({ echoed: input.value }),
    ...overrides,
  }) as AnyTestTool;
}

function makeEnv(options: {
  tools: AnyTestTool[];
  askPermission?: ToolExecutionEnvironment['askPermission'];
  state?: ToolExecutionState;
}): ToolExecutionEnvironment {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    abortSignal: new AbortController().signal,
    toolPool: new ToolPool(options.tools as never),
    permissionContext: PERMISSION_CONTEXT,
    ...(options.askPermission ? { askPermission: options.askPermission } : {}),
    toolContext: { workspaceRoot: '', platform: process.platform },
    ...(options.state ? { toolExecutionState: options.state } : {}),
  };
}

function makeCall(env: ToolExecutionEnvironment, name: string, args: unknown): {
  execution: ToolCallExecution;
  events: ToolExecutionEvent[];
} {
  const events: ToolExecutionEvent[] = [];
  const execution = new ToolCallExecution(
    env,
    { callId: 'call-1', name, args },
    event => events.push(event),
  );
  return { execution, events };
}

describe('ToolCallExecution', () => {
  it('模型幻觉不存在的工具名 → tool/unavailable,不产生状态迁移', async () => {
    const { state, store } = makeState();
    const { execution } = makeCall(makeEnv({ tools: [], state }), 'Ghost', {});

    const { result } = await execution.run();

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe('tool/unavailable');
    expect(store.listForTurn(TURN_ID)).toHaveLength(0);
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
    const checkPermissions = vi.fn(async () => ({ behavior: 'allow' as const }));
    const tool = echoTool({
      validateInput: () => ({ valid: false as const, message: '已存在', code: 'file/exists' }),
      checkPermissions,
    });
    const { state, store } = makeState();
    const { execution } = makeCall(
      makeEnv({ tools: [tool], state }),
      'Echo',
      { value: 1 },
    );

    const { result } = await execution.run();

    expect(result.errorCode).toBe('file/exists');
    expect(checkPermissions).not.toHaveBeenCalled();
    expect(store.listForTurn(TURN_ID)).toHaveLength(0);
  });

  it('Tool 自检拒绝 → permission/denied,不越过 running 边界', async () => {
    const tool = echoTool({
      checkPermissions: async () => ({ behavior: 'deny' as const, message: '危险输入' }),
    });
    const { state, store } = makeState();
    const { execution } = makeCall(
      makeEnv({ tools: [tool], state }),
      'Echo',
      { value: 1 },
    );

    const { result } = await execution.run();

    expect(result.errorCode).toBe('permission/denied');
    expect(store.findByCallId('call-1')?.status).toBe('prepared');
  });

  it('ask 决策走交互通道:请求携带身份、摘要与规则建议,allowSession 后放行', async () => {
    const seen: PermissionRequest[] = [];
    const tool = echoTool({
      getToolUseSummary: () => '回显一个数字',
      checkPermissions: async () => ({
        behavior: 'ask' as const,
        message: '需要确认',
        ruleSuggestion: { toolName: 'Echo' },
      }),
    });
    const { execution } = makeCall(
      makeEnv({
        tools: [tool],
        askPermission: async (request) => {
          seen.push(request);
          return { action: 'allowSession' };
        },
      }),
      'Echo',
      { value: 1 },
    );

    const { result } = await execution.run();

    expect(result.isError).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      toolName: 'Echo',
      toolDescription: '回显一个数字',
      toolCallId: 'call-1',
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      ruleSuggestion: { toolName: 'Echo' },
    });
  });

  it('ask 决策被用户拒绝 → permission/denied 并带用户理由', async () => {
    const tool = echoTool({
      checkPermissions: async () => ({ behavior: 'ask' as const, message: '需要确认' }),
    });
    const { execution } = makeCall(
      makeEnv({
        tools: [tool],
        askPermission: async () => ({ action: 'deny' as const, reason: '不想做' }),
      }),
      'Echo',
      { value: 1 },
    );

    const { result } = await execution.run();

    expect(result.errorCode).toBe('permission/denied');
    expect(result.content).toBe('不想做');
  });

  it('ask 决策无交互通道 → deny(headless),不调用任何通道', async () => {
    const tool = echoTool({
      checkPermissions: async () => ({ behavior: 'ask' as const, message: '需要确认' }),
    });
    const { execution } = makeCall(makeEnv({ tools: [tool] }), 'Echo', { value: 1 });

    const { result } = await execution.run();

    expect(result.errorCode).toBe('permission/denied');
  });

  it('成功执行:结果规范化、终态事件齐备、commitResult 后落 succeeded', async () => {
    const { state, store } = makeState();
    const { execution, events } = makeCall(
      makeEnv({ tools: [echoTool()], state }),
      'Echo',
      { value: 42 },
    );

    const { result, terminalEvent } = await execution.run();
    execution.commitResult();

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content as string)).toEqual({ echoed: 42 });
    expect(terminalEvent.type).toBe('tool_result');
    expect(store.findByCallId('call-1')?.status).toBe('succeeded');
    expect(events.some(e => e.type === 'tool_result')).toBe(false);
  });

  it('自定义 mapResultToModelContent 优先于缺省 JSON 投影,data 槽携带 TOutput 本体', async () => {
    const tool = echoTool({
      mapResultToModelContent: (output) =>
        `echo 完成:${(output as { echoed: number }).echoed}`,
    });
    const { execution } = makeCall(makeEnv({ tools: [tool] }), 'Echo', { value: 7 });

    const { result } = await execution.run();

    expect(result.content).toBe('echo 完成:7');
    expect(result.data).toEqual({ echoed: 7 });
  });

  it('map 返回多模态 parts 时原样直通,不做文本外置也不 JSON 化', async () => {
    const parts = [
      { type: 'text' as const, text: '看图:' },
      { type: 'image_data' as const, data: 'aGVsbG8=', mimeType: 'image/png' },
    ];
    const tool = echoTool({ mapResultToModelContent: () => parts });
    const { execution } = makeCall(makeEnv({ tools: [tool] }), 'Echo', { value: 1 });

    const { result } = await execution.run();

    expect(result.content).toBe(parts);
    expect(result.isError).toBe(false);
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
    const { state, store } = makeState();
    const { execution } = makeCall(
      makeEnv({ tools: [tool], state }),
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
    expect(store.findByCallId('call-1')?.status).toBe('outcome_unknown');
    expect(terminalEvent).toMatchObject({
      error: { code: 'tool/cancelled' },
    });
  });
});
