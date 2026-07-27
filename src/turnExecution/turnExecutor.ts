// 管理根 Turn 的身份、生命周期 Hook、唯一终态、取消和对外事件句柄。

import * as fs from 'node:fs';
import { asAgentRunId, type TurnId } from '@ema-agent/ids';
import type { TurnFailurePhase } from '@ema-agent/hooks';
import type { Turn } from '@ema-agent/session';
import {
  RootAgentExecution,
  type RootAgentExecutionResult,
} from './rootAgentExecution.js';
import { TurnPreparationError } from './errors.js';
import {
  TurnEventChannel,
  TurnEventChannelClosedError,
} from './turnEventChannel.js';
import type {
  TurnExecutionDeps,
  TurnExecutionEvent,
  TurnHandle,
  TurnInput,
  TurnOutcome,
  TurnPreparationContext,
  TurnStartCommand,
} from './types.js';

/**
 * 根 Turn 的产品执行入口。
 *
 * 输入准备和根 Agent 执行都由明确协作者完成；本层只提交一次根终态，
 * 并把传输无关事件交给 TurnHandle。
 */
export class TurnExecutor {
  constructor(
    private readonly deps: TurnExecutionDeps,
    private readonly rootAgent: RootAgentExecution,
  ) {}

  /**
   * 同步创建 Turn 并立刻返回稳定句柄。输入准备和模型执行在内部启动；
   * 事件通道使用固定容量反压，不会因调用方迟迟不消费而无限积压。
   */
  start(command: TurnStartCommand): TurnHandle {
    const { turn, signal } = this.deps.session.startTurn({
      sessionId: command.sessionId,
      triggerType: command.triggerType,
      executionProfile: command.executionProfile,
      narrativePolicy: command.narrativePolicy,
      userInput: command.userInput,
    });
    const channel = new TurnEventChannel<TurnExecutionEvent>(() => {
      this.abort(turn.id);
    });

    let resolveCompletion!: (outcome: TurnOutcome) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<TurnOutcome>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // LocalHost 迁移期主要消费 events；预先观察 rejection，避免极端持久化
    // 故障形成未处理 Promise。调用方仍可 await 原 Promise 得到同一错误。
    void completion.catch(() => undefined);

    void this.pumpTurn(
      command,
      { turn, signal },
      channel,
      resolveCompletion,
      rejectCompletion,
    );

    return Object.freeze({
      sessionId: turn.sessionId,
      turnId: turn.id,
      events: channel,
      completion,
      abort: () => {
        this.abort(turn.id);
      },
    });
  }

  /**
   * 只取消当前仍处于活动状态的指定根 Turn。
   *
   * 历史句柄或陈旧客户端携带的 turnId 不能按 Session 误杀后续 Turn；
   * 活动身份继续以 Session 自己的运行注册表为唯一事实来源。
   */
  abort(turnId: TurnId): boolean {
    const turn = this.deps.session.getTurn(turnId);
    if (!turn) return false;

    const activeTurn = this.deps.session.getActiveTurn(turn.sessionId);
    if (activeTurn?.id !== turnId) return false;

    this.deps.session.requestAbort(turn.sessionId);
    return true;
  }

  /** 只取消指定子 AgentRun，不中止父 Turn。 */
  abortAgentRun(turnId: string, agentRunId: string): void {
    this.rootAgent.abortAgentRun(turnId, asAgentRunId(agentRunId));
  }

  /** 只取消指定工具调用；找不到时返回 false。 */
  abortTool(turnId: string, toolCallId: string): boolean {
    return this.rootAgent.abortTool(turnId, toolCallId);
  }

  private async pumpTurn(
    command: TurnStartCommand,
    started: TurnPreparationContext,
    channel: TurnEventChannel<TurnExecutionEvent>,
    resolveCompletion: (outcome: TurnOutcome) => void,
    rejectCompletion: (error: unknown) => void,
  ): Promise<void> {
    const { turn, signal } = started;
    let input: TurnInput | undefined;
    let outcome: TurnOutcome | undefined;

    try {
      input = await command.prepare(started);
      outcome = await this.executePreparedTurn(
        turn,
        input,
        signal,
        channel,
      );
      resolveCompletion(outcome);
      channel.finish();
    } catch (error) {
      if (outcome) {
        resolveCompletion(outcome);
        channel.finish();
        return;
      }

      try {
        outcome = await this.finishStartFailure(
          turn,
          signal,
          error,
          channel,
        );
        resolveCompletion(outcome);
        channel.finish();
      } catch (terminalError) {
        rejectCompletion(terminalError);
        channel.fail(terminalError);
      }
    } finally {
      try {
        const status = outcome?.status ?? (signal.aborted ? 'aborted' : 'failed');
        this.deps.interactions.cancelForTurn(turn.id, `turn ${status}`);
      } catch {
        // 内存交互队列清理故障不能覆盖已经确定的根 Turn 终态。
      }
      if (input?.scratchpadDir) {
        try {
          fs.rmSync(input.scratchpadDir, {
            recursive: true,
            force: true,
          });
        } catch {
          // 临时目录清理失败不能覆盖已经确定的 Turn 终态。
        }
      }
      this.deps.session.clearRunning(turn.sessionId);
    }
  }

  private async executePreparedTurn(
    turn: Turn,
    input: TurnInput,
    signal: AbortSignal,
    channel: TurnEventChannel<TurnExecutionEvent>,
  ): Promise<TurnOutcome> {
    const startHookEvents: TurnExecutionEvent[] = [];
    let startResult;
    try {
      startResult = await this.deps.hooks.trigger('onTurnStart', {
        turnId: turn.id,
        sessionId: turn.sessionId,
        payload: {
          executionProfile: turn.executionProfile,
          narrativePolicy: turn.narrativePolicy,
        },
        signal,
        emit: (event) => startHookEvents.push(event),
      });
    } catch (error) {
      return this.finishFailed(
        turn,
        executionFailure(error, 'hook'),
        channel,
      );
    }
    await pushEvents(channel, startHookEvents);

    if (startResult.kind === 'abort') {
      return this.finishFailed(
        turn,
        {
          status: 'failed',
          code: 'turn/hook_aborted',
          message: startResult.reason,
          phase: 'hook',
        },
        channel,
      );
    }

    await channel.push({
      type: 'turn_started',
      sessionId: turn.sessionId,
      turnId: turn.id,
      executionProfile: turn.executionProfile,
      narrativePolicy: turn.narrativePolicy,
    });
    for (const degradation of input.requestDegradations) {
      await channel.push({
        type: 'request_degraded',
        sessionId: turn.sessionId,
        turnId: turn.id,
        ...degradation,
      });
    }

    const result = await this.drainRootAgent(
      turn,
      input,
      signal,
      channel,
    );
    switch (result.status) {
      case 'completed':
        return this.finishCompleted(turn, result, signal, channel);
      case 'failed':
        return this.finishFailed(turn, result, channel);
      case 'aborted':
        return this.finishAborted(turn, result.reason, channel);
    }
  }

  private async drainRootAgent(
    turn: Turn,
    input: TurnInput,
    signal: AbortSignal,
    channel: TurnEventChannel<TurnExecutionEvent>,
  ): Promise<RootAgentExecutionResult> {
    const execution = this.rootAgent.run({ turn, input, signal });
    let finished = false;

    try {
      let step = await execution.next();
      while (!step.done) {
        await channel.push(step.value);
        step = await execution.next();
      }
      finished = true;
      return step.value;
    } finally {
      if (!finished) {
        await execution.return({
          status: 'aborted',
          reason: 'event_consumer_closed',
        });
      }
    }
  }

  private async finishCompleted(
    turn: Turn,
    result: Extract<RootAgentExecutionResult, { status: 'completed' }>,
    signal: AbortSignal,
    channel: TurnEventChannel<TurnExecutionEvent>,
  ): Promise<TurnOutcome> {
    const durationMs = Date.now() - turn.startedAt;
    const hookEvents: TurnExecutionEvent[] = [];
    try {
      await this.deps.hooks.trigger('onTurnEnd', {
        turnId: turn.id,
        sessionId: turn.sessionId,
        payload: { durationMs },
        signal,
        emit: (event) => hookEvents.push(event),
      });
    } catch (error) {
      return this.finishFailed(
        turn,
        executionFailure(error, 'hook'),
        channel,
      );
    }
    await pushTerminalEvents(channel, hookEvents);

    const stats = {
      iterations: result.iterations,
      usageInputTokens: result.inputTokens,
      usageOutputTokens: result.outputTokens,
    };
    try {
      this.deps.session.completeTurn(turn.id, stats);
    } catch (error) {
      return this.finishFailed(
        turn,
        executionFailure(error, 'persistence'),
        channel,
      );
    }

    const outcome: TurnOutcome = {
      status: 'completed',
      sessionId: turn.sessionId,
      turnId: turn.id,
      stats: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs,
      },
    };
    await pushUnlessConsumerClosed(channel, {
      type: 'turn_completed',
      sessionId: outcome.sessionId,
      turnId: outcome.turnId,
      stats: outcome.stats,
    });
    return outcome;
  }

  private async finishFailed(
    turn: Turn,
    result: Extract<RootAgentExecutionResult, { status: 'failed' }>,
    channel: TurnEventChannel<TurnExecutionEvent>,
  ): Promise<TurnOutcome> {
    this.deps.session.failTurn(turn.id, result.code, result.message);

    const hookEvents: TurnExecutionEvent[] = [];
    await this.deps.hooks.trigger('onTurnFailure', {
      turnId: turn.id,
      sessionId: turn.sessionId,
      payload: {
        phase: result.phase,
        code: result.code,
        message: result.message,
        durationMs: Date.now() - turn.startedAt,
      },
      emit: (event) => hookEvents.push(event),
    });
    await pushTerminalEvents(channel, hookEvents);

    const outcome: TurnOutcome = {
      status: 'failed',
      sessionId: turn.sessionId,
      turnId: turn.id,
      code: result.code,
      message: result.message,
    };
    await pushUnlessConsumerClosed(channel, {
      type: 'turn_failed',
      sessionId: outcome.sessionId,
      turnId: outcome.turnId,
      code: outcome.code,
      message: outcome.message,
    });
    return outcome;
  }

  private async finishAborted(
    turn: Turn,
    reason: string,
    channel: TurnEventChannel<TurnExecutionEvent>,
  ): Promise<TurnOutcome> {
    const hookEvents: TurnExecutionEvent[] = [];
    await this.deps.hooks.trigger('onTurnAbort', {
      turnId: turn.id,
      sessionId: turn.sessionId,
      payload: { reason },
      emit: (event) => hookEvents.push(event),
    });
    await pushTerminalEvents(channel, hookEvents);

    this.deps.session.abortTurn(turn.sessionId, turn.id);
    const outcome: TurnOutcome = {
      status: 'aborted',
      sessionId: turn.sessionId,
      turnId: turn.id,
      reason,
    };
    await pushUnlessConsumerClosed(channel, {
      type: 'turn_aborted',
      sessionId: outcome.sessionId,
      turnId: outcome.turnId,
      reason: outcome.reason,
    });
    return outcome;
  }

  private async finishStartFailure(
    turn: Turn,
    signal: AbortSignal,
    error: unknown,
    channel: TurnEventChannel<TurnExecutionEvent>,
  ): Promise<TurnOutcome> {
    if (signal.aborted || error instanceof TurnEventChannelClosedError) {
      return this.finishAborted(turn, 'user_stop', channel);
    }

    const code = error instanceof TurnPreparationError
      ? error.code
      : 'turn/setup_failed';
    const message = error instanceof Error ? error.message : String(error);
    return this.finishFailed(
      turn,
      {
        status: 'failed',
        code,
        message,
        phase: 'setup',
      },
      channel,
    );
  }

}

async function pushEvents(
  channel: TurnEventChannel<TurnExecutionEvent>,
  events: readonly TurnExecutionEvent[],
): Promise<void> {
  for (const event of events) {
    await channel.push(event);
  }
}

async function pushTerminalEvents(
  channel: TurnEventChannel<TurnExecutionEvent>,
  events: readonly TurnExecutionEvent[],
): Promise<void> {
  for (const event of events) {
    await pushUnlessConsumerClosed(channel, event);
  }
}

async function pushUnlessConsumerClosed(
  channel: TurnEventChannel<TurnExecutionEvent>,
  event: TurnExecutionEvent,
): Promise<void> {
  try {
    await channel.push(event);
  } catch (error) {
    if (!(error instanceof TurnEventChannelClosedError)) throw error;
  }
}

function executionFailure(
  error: unknown,
  phase: TurnFailurePhase,
): Extract<RootAgentExecutionResult, { status: 'failed' }> {
  return {
    status: 'failed',
    code: 'turn/execution_failed',
    message: error instanceof Error ? error.message : String(error),
    phase,
  };
}
