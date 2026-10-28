import type { AgentLoopEvent } from '@ema-agent/agent';
import type { Goal } from '@ema-agent/goal';
import type { Turn, TurnOutcome } from '../types.js';
import { failureCodeOf, failureMessageOf } from '../errors.js';
import type { TurnToolsAssembly } from '../tools/turnTools.js';
import type { TurnMessageWriter } from './turnMessageWriter.js';
import type { TurnExecutorDeps } from './turnExecutor.js';

export function determineTurnOutcome(
  turn: Turn,
  stopped: Extract<AgentLoopEvent, { type: 'loop_stopped' }>,
  currentGoal: Goal | null | undefined,
  handledGoalId: string | undefined,
): TurnOutcome {
  const { sessionId, id: turnId } = turn;
  const reason = stopped.state.stopReason;
  if (reason === 'aborted') {
    return { status: 'aborted', sessionId, turnId, reason: 'user_stop' };
  }
  const goalContinues = reason === 'max_iterations'
    && currentGoal?.status === 'active' && currentGoal.id === handledGoalId;
  if (reason === 'completed' || goalContinues) {
    return { status: 'completed', sessionId, turnId };
  }
  return {
    status: 'failed', sessionId, turnId,
    code: reason === 'max_iterations' ? 'turn/budget_exceeded' : 'turn/execution_failed',
    message: `AgentLoop 终止: ${reason}`,
  };
}

export async function finishTurn(
  deps: TurnExecutorDeps,
  input: {
    readonly turn: Turn;
    readonly signal: AbortSignal;
    readonly writer: TurnMessageWriter;
    readonly tools: TurnToolsAssembly | undefined;
    readonly outcome: TurnOutcome;
    readonly handledGoalId: string | undefined;
  },
): Promise<TurnOutcome> {
  const { turn, signal, writer, tools, handledGoalId } = input;
  const { sessionId, id: turnId } = turn;
  let outcome = input.outcome;
  let continuationStatus: 'completed' | 'failed' | 'aborted' = 'failed';

  const pauseHandledGoal = (): void => {
    if (!handledGoalId || !deps.goalStore) return;
    const goal = deps.goalStore.get(sessionId, handledGoalId);
    if (goal?.status === 'active') {
      deps.goalStore.pause({ sessionId, goalId: goal.id, expectedVersion: goal.version });
    }
  };

  try {
    deps.interactionQueue.cancelForTurn(turnId, `turn ${outcome.status}`);
    if (outcome.status === 'aborted') deps.turns.requestAbort(sessionId, turnId);
    // 先等工具响应取消并退出, 超过执行器的等待期限则停止接收迟到事件.
    // 即使工具收尾失败, 也继续尝试结束所属电脑操控, 再统一记录清理失败.
    const toolCleanup = await Promise.allSettled([tools?.shutdown(outcome.status)]);
    // 停止准备中的 Turn 时 tools 可能尚未创建, 所以结束操控不能放进 tools.shutdown.
    // 用户也可能在等待工具退出时按停止, 因此此时再读 signal. 正常完成 Turn 则保留操控.
    const computerCleanup = await Promise.allSettled([
      signal.aborted ? deps.computerUse?.endSession(sessionId) : undefined,
    ]);
    const failure = [...toolCleanup, ...computerCleanup].find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      outcome = {
        status: 'failed',
        sessionId,
        turnId,
        code: failureCodeOf(failure.reason),
        message: failureMessageOf(failure.reason),
      };
    } else if (signal.aborted) {
      outcome = { status: 'aborted', sessionId, turnId, reason: 'user_stop' };
    }

    // 消息保存和调用配对完成后, 才提交成功状态及 Memory 提取任务.
    await writer.finish(outcome.status);
    if (outcome.status !== 'completed') pauseHandledGoal();
    if (outcome.status === 'completed') {
      deps.turns.completeTurn(turnId, () => deps.onTurnCompletedInTransaction?.(turnId));
    } else if (outcome.status === 'aborted') {
      deps.turns.abortTurn(sessionId, turnId);
    } else {
      deps.turns.failTurn(turnId, { errorCode: outcome.code, errorMessage: outcome.message });
    }
    continuationStatus = outcome.status;
    return outcome;
  } catch (error) {
    pauseHandledGoal();
    const failed: TurnOutcome = {
      status: 'failed',
      sessionId,
      turnId,
      code: failureCodeOf(error),
      message: failureMessageOf(error),
    };
    deps.turns.failTurn(turnId, { errorCode: failed.code, errorMessage: failed.message });
    return failed;
  } finally {
    deps.turns.clearRunning(sessionId, turnId);
    deps.continuations.workFinished(sessionId, continuationStatus);
  }
}
