// 测试 Tool 执行状态机的合法迁移、CAS 冲突防护与从 Message 事实推终态。
import { describe, expect, it } from 'vitest';
import { asSessionId, asToolCallId, asTurnId, type SessionId, type TurnId } from '@ema-agent/ids';
import {
  ToolExecutionState,
  ToolExecutionStateConflictError,
  type ToolExecutionRecord,
  type ToolExecutionStateStore,
  type ToolExecutionStatus,
} from '../index.js';

const SESSION_ID = asSessionId('00000000-0000-4000-8000-0000000000a1');
const TURN_ID = asTurnId('00000000-0000-4000-8000-0000000000b1');

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

  listForTurn(turnId: TurnId) {
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

function createState(): { state: ToolExecutionState; callId: ReturnType<typeof asToolCallId> } {
  const state = new ToolExecutionState(new InMemoryStore());
  const callId = asToolCallId('call-1');
  state.prepare({
    callId,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    toolName: 'Bash',
  });
  return { state, callId };
}

describe('ToolExecutionState', () => {
  it('prepared → authorized → running → succeeded 是唯一的成功路径', () => {
    const { state, callId } = createState();
    expect(state.authorize(callId).status).toBe('authorized');
    expect(state.start(callId).status).toBe('running');
    const terminal = state.succeed(callId);
    expect(terminal.status).toBe('succeeded');
    expect(terminal.completedAt).toBeTypeOf('number');
  });

  it('cancel 只允许从 prepared/authorized;running 上取消会撞 CAS', () => {
    const { state, callId } = createState();
    state.authorize(callId);
    state.start(callId);
    expect(() => state.cancel(callId)).toThrow(ToolExecutionStateConflictError);
  });

  it('outcome_unknown 只允许从 running;prepared 上标记会撞 CAS', () => {
    const { state, callId } = createState();
    expect(() => state.outcomeUnknown(callId)).toThrow(ToolExecutionStateConflictError);
  });

  it('running 中取消按 outcome_unknown 关账而非 cancelled', () => {
    const { state, callId } = createState();
    state.authorize(callId);
    state.start(callId);
    expect(state.outcomeUnknown(callId).status).toBe('outcome_unknown');
  });

  it('同 callId 同身份重复 prepare 幂等;换身份则冲突', () => {
    const { state, callId } = createState();
    const again = state.prepare({
      callId,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      toolName: 'Bash',
    });
    expect(again.status).toBe('prepared');
    expect(() => state.prepare({
      callId,
      sessionId: SESSION_ID,
      turnId: asTurnId('00000000-0000-4000-8000-0000000000c1'),
      toolName: 'Bash',
    })).toThrow(ToolExecutionStateConflictError);
  });

  it('completeFromMessage 按 Message 事实映射终态', () => {
    const make = () => createState();
    const succeeded = make();
    expect(succeeded.state.completeFromMessage(succeeded.callId, {}).status).toBe('succeeded');

    const failed = make();
    expect(failed.state.completeFromMessage(failed.callId, { isError: true }).status).toBe('failed');

    const cancelled = make();
    expect(
      cancelled.state.completeFromMessage(cancelled.callId, { isError: true, errorCode: 'tool/cancelled' }).status,
    ).toBe('cancelled');

    const unknown = make();
    unknown.state.authorize(unknown.callId);
    unknown.state.start(unknown.callId);
    expect(
      unknown.state.completeFromMessage(unknown.callId, { isError: true, errorCode: 'tool/outcome_unknown' }).status,
    ).toBe('outcome_unknown');
  });

  it('listInterrupted 只含未越副作用边界的非终态调用', () => {
    const { state, callId } = createState();
    expect(state.listInterrupted().map(r => r.callId)).toEqual([callId]);
    state.authorize(callId);
    state.start(callId);
    state.succeed(callId);
    expect(state.listInterrupted()).toHaveLength(0);
  });
});
