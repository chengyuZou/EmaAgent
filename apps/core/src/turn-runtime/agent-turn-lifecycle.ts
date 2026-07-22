// 统一提交根 Agent Turn 与 AgentTask 的创建和终态，避免两张表出现分裂状态。

import type { SessionId, TurnId } from '@ema-agent/ids';
import type { TurnFailureCode } from '@ema-agent/turn';
import type { IAgentTurnLifecycle } from '@ema-agent/agent';
import type { AgentTaskStore, TaskTransitionResult } from '@ema-agent/agent-task';
import type {
  SessionStore,
  StartTurnInput,
  Turn,
} from '@ema-agent/session';
import { AgentTurnLifecycleError } from './errors.js';

export interface StartedAgentTurn {
  turn: Turn;
  signal: AbortSignal;
}

export type RunDataTransaction = <T>(work: () => T) => T;

export class AgentTurnLifecycleFacade implements IAgentTurnLifecycle {
  constructor(
    private readonly session: SessionStore,
    private readonly tasks: AgentTaskStore,
    private readonly runDataTransaction: RunDataTransaction,
  ) {}

  start(input: StartTurnInput): StartedAgentTurn {
    let started: StartedAgentTurn | undefined;
    try {
      return this.runDataTransaction(() => {
        started = this.session.startTurn(input);
        const task = this.tasks.claim({
          taskId: started.turn.id,
          sessionId: started.turn.sessionId,
          turnId: started.turn.id,
          parentId: null,
        });
        if (
          task.status !== 'running'
          || task.sessionId !== started.turn.sessionId
          || task.turnId !== started.turn.id
          || task.parentId !== null
        ) {
          throw new AgentTurnLifecycleError(
            'start',
            started.turn.id,
            `root task conflicts with existing ${task.status} task`,
          );
        }
        return started;
      });
    } catch (error) {
      // startTurn 注册了内存锁；若后续 Task 写入令事务回滚，也必须同步释放。
      if (started) this.session.clearRunning(started.turn.sessionId);
      throw error;
    }
  }

  complete(input: {
    turnId: TurnId;
    iterations: number;
    inputTokens: number;
    outputTokens: number;
  }): void {
    this.runDataTransaction(() => {
      this.requireTransition('complete', input.turnId, this.tasks.complete(input.turnId, {
        iterations: input.iterations,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
      }));
      this.session.completeTurn(input.turnId, {
        usageInputTokens: input.inputTokens,
        usageOutputTokens: input.outputTokens,
        iterations: input.iterations,
      });
    });
  }

  fail(input: { turnId: TurnId; code: TurnFailureCode; message: string }): void {
    this.runDataTransaction(() => {
      this.requireTransition('fail', input.turnId, this.tasks.fail(input.turnId, input.message));
      this.session.failTurn(input.turnId, input.code, input.message);
    });
  }

  abort(input: { sessionId: SessionId; turnId: TurnId; reason: string }): void {
    this.runDataTransaction(() => {
      this.requireTransition('abort', input.turnId, this.tasks.cancel(input.turnId, input.reason));
      this.session.abortTurn(input.sessionId, input.turnId);
    });
  }

  private requireTransition(
    action: 'complete' | 'fail' | 'abort',
    turnId: TurnId,
    result: TaskTransitionResult,
  ): void {
    if (result.ok) return;
    const detail = result.reason === 'not_found'
      ? 'root task is missing'
      : `root task is already ${result.current?.status ?? 'in a conflicting state'}`;
    throw new AgentTurnLifecycleError(action, turnId, detail);
  }
}
