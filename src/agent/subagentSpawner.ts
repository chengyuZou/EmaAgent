// 管理子 AgentRun 的持久生命周期、取消树与后台等待。

import { randomUUID } from 'node:crypto';
import type {
  SubagentRunResult,
  SubagentSpawnerPort,
  SubagentSpawnOptions,
} from '@ema-agent/tools';
import { runAgentLoop } from './agentLoop.js';
import type { AgentLoopEvent, AgentRunEvent } from './events.js';
import type { AgentLoopInput, AgentBudget } from './types.js';
import { AgentRunStore } from './runs/agentRunStore.js';
import { AgentRunMessagesStore } from './runs/agentRunMessagesStore.js';

const OUTPUT_EXCERPT_MAX = 200;

export interface PrepareSubagentInput {
  readonly agentRunId: string;
  readonly prompt: string;
  readonly options: SubagentSpawnOptions;
  readonly signal: AbortSignal;
}

export type PrepareSubagent = (
  input: PrepareSubagentInput,
) => Promise<AgentLoopInput>;

export interface SubagentSpawnerOptions {
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly parentAgentRunId?: string;
  readonly providerId?: string; 
  readonly defaultModelId?: string;
  readonly budget: AgentBudget;
  readonly prepareSubagent: PrepareSubagent;
  readonly agentRunStore: AgentRunStore;
  readonly messagesStore: AgentRunMessagesStore;
  readonly emit: (event: AgentRunEvent) => void;
}

export class SubagentSpawner implements SubagentSpawnerPort {
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeRuns = new Map<string, Promise<SubagentRunResult>>();
  private readonly backgroundRuns = new Map<string, Promise<SubagentRunResult>>();
  private stoppingReason: string | undefined;

  constructor(private readonly options: SubagentSpawnerOptions) {}

  async spawn(
    prompt: string,
    options: SubagentSpawnOptions,
    signal: AbortSignal,
  ): Promise<SubagentRunResult> {
    const agentRunId = options.agentRunId ?? randomUUID();
    return this.start(prompt, { ...options, agentRunId }, signal);
  }

  spawnBackground(
    prompt: string,
    options: SubagentSpawnOptions,
    signal: AbortSignal,
  ): string {
    const agentRunId = options.agentRunId ?? randomUUID();
    const promise = this.start(prompt, { ...options, agentRunId }, signal);
    this.backgroundRuns.set(agentRunId, promise);
    // 后台结果由 awaitBackground 读取；无人读取时也不能产生未处理拒绝。
    void promise.catch(() => undefined);
    return agentRunId;
  }

  async awaitBackground(agentRunId: string): Promise<SubagentRunResult | null> {
    const promise = this.backgroundRuns.get(agentRunId);
    if (!promise) return null;
    try {
      return await promise;
    } finally {
      this.backgroundRuns.delete(agentRunId);
    }
  }

  abortSubagent(agentRunId: string): boolean {
    const controller = this.controllers.get(agentRunId);
    if (!controller) return false;
    controller.abort(new Error('Sub-agent aborted by user'));
    return true;
  }

  async shutdown(reason: string): Promise<void> {
    this.stoppingReason = reason;
    for (const controller of this.controllers.values()) {
      controller.abort(new Error(reason));
    }
    await Promise.allSettled(this.activeRuns.values());
    this.activeRuns.clear();
    this.backgroundRuns.clear();
  }

  private start(
    prompt: string,
    spawnOptions: SubagentSpawnOptions & { readonly agentRunId: string },
    parentSignal: AbortSignal,
  ): Promise<SubagentRunResult> {
    const { agentRunId } = spawnOptions;
    if (this.activeRuns.has(agentRunId) || this.backgroundRuns.has(agentRunId)) {
      throw new Error(`AgentRun ${agentRunId} 已经在运行`);
    }

    const promise = this.execute(prompt, spawnOptions, parentSignal);
    this.activeRuns.set(agentRunId, promise);
    void promise.finally(() => {
      this.activeRuns.delete(agentRunId);
      this.controllers.delete(agentRunId);
    }).catch(() => undefined);
    return promise;
  }

  private async execute(
    prompt: string,
    spawnOptions: SubagentSpawnOptions & { readonly agentRunId: string },
    parentSignal: AbortSignal,
  ): Promise<SubagentRunResult> {
    const { agentRunId } = spawnOptions;
    const releaseBudget = this.options.budget.enterSubagent();
    const controller = new AbortController();
    const abortFromParent = (): void => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
    this.controllers.set(agentRunId, controller);

    const startedAt = Date.now();
    const contextMode = spawnOptions.contextMode ?? 'subagent';
    const providerId = spawnOptions.providerId ?? this.options.providerId;
    const modelId = spawnOptions.modelId ?? this.options.defaultModelId;
    let toolCallCount = 0;

    this.options.agentRunStore.start({
      agentRunId,
      sessionId: this.options.parentSessionId,
      parentTurnId: this.options.parentTurnId,
      ...(this.options.parentAgentRunId !== undefined
        ? { parentAgentRunId: this.options.parentAgentRunId }
        : {}),
      ...(spawnOptions.taskId !== undefined ? { taskId: spawnOptions.taskId } : {}),
      contextMode,
      ...(spawnOptions.description !== undefined
        ? { description: spawnOptions.description }
        : {}),
      ...(providerId !== undefined
        ? { providerId }
        : {}),
      ...(modelId !== undefined ? { modelId } : {}),
    });
    this.options.emit({
      type: 'agent_run_started',
      agentRunId,
      contextMode,
      ...(modelId !== undefined ? { modelId } : {}),
      ...(spawnOptions.description !== undefined
        ? { description: spawnOptions.description }
        : {}),
      startedAt,
    });

    try {
      const loopInput = await this.options.prepareSubagent({
        agentRunId,
        prompt,
        options: spawnOptions,
        signal: controller.signal,
      });
      let terminal: Extract<AgentLoopEvent, { type: 'loop_stopped' }> | undefined;
      for await (const event of runAgentLoop(loopInput)) {
        if (event.type === 'tool_use_completed') toolCallCount += 1;
        // 先写消息记录，再恢复 generator，严格守住工具副作用和结果关账边界。
        this.options.messagesStore.record(agentRunId, event);
        this.options.emit({ type: 'agent_run_event', agentRunId, event });
        if (event.type === 'loop_stopped') terminal = event;
      }

      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('Sub-agent aborted');
      }
      if (!terminal) throw new Error('AgentLoop 未产生终止事件');

      const durationMs = Date.now() - startedAt;
      const completion = this.options.agentRunStore.complete(agentRunId, {
        iterations: terminal.state.iterations,
        toolCallCount,
        inputTokens: terminal.state.usage.inputTokens,
        outputTokens: terminal.state.usage.outputTokens,
        outputExcerpt: terminal.finalText.slice(0, OUTPUT_EXCERPT_MAX),
      });
      assertTransitionCompleted(agentRunId, completion, 'complete');
      this.options.emit({
        type: 'agent_run_completed',
        agentRunId,
        finalText: terminal.finalText,
        state: terminal.state,
        durationMs,
      });
      return {
        agentRunId,
        output: terminal.finalText,
        usage: {
          inputTokens: terminal.state.usage.inputTokens,
          outputTokens: terminal.state.usage.outputTokens,
        },
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        const reason = parentSignal.aborted
          ? 'parent_aborted'
          : this.stoppingReason ?? 'user_aborted';
        const cancellation = this.options.agentRunStore.cancel(agentRunId, reason);
        assertTransitionCompleted(agentRunId, cancellation, 'cancel');
        this.options.emit({
          type: 'agent_run_aborted',
          agentRunId,
          reason,
          durationMs,
        });
      } else {
        const failure = this.options.agentRunStore.fail(agentRunId, message);
        assertTransitionCompleted(agentRunId, failure, 'fail');
        this.options.emit({
          type: 'agent_run_failed',
          agentRunId,
          error: message,
          durationMs,
        });
      }
      throw error;
    } finally {
      parentSignal.removeEventListener('abort', abortFromParent);
      releaseBudget();
    }
  }
}

function assertTransitionCompleted(
  agentRunId: string,
  result: ReturnType<AgentRunStore['complete']>,
  action: 'complete' | 'fail' | 'cancel',
): void {
  if (result.ok) return;
  throw new Error(
    `AgentRun ${agentRunId} 无法写入 ${action} 终态：${result.reason}`,
  );
}
