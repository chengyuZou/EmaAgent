// 为一个根 Turn 准备历史与临时召回，并在每次模型调用前装配可压缩的上下文快照。

import {
  buildModelMessages,
  buildRuntimeEnvironmentSnapshot,
  ContextAssembler,
  computeContextUsage,
  type ContextCompactor,
  type ContextContribution,
  type ContextRuntimeEvent,
  type ContextUsageEstimate,
  type ModelContextSnapshot,
  prepareHistoricalMessageView,
  validateCurrentContent,
} from '@ema-agent/context';
import type { MemoryRecallEvent, MemoryRecallPort } from '@ema-agent/memory';
import {
  LlmModelCapabilityError,
  type Message as ModelMessage,
  type UserBlock,
} from '@ema-agent/llm';
import {
  NarrativeClientError,
  prepareNarrativeRecall,
  type NarrativeClient,
  type NarrativeEvent,
  type NarrativeRecallTimeline,
} from '@ema-agent/narrative';
import type { SessionStore, Turn } from '@ema-agent/session';
import {
  renderActiveSkillContext,
  type ActivatedSkill,
} from '@ema-agent/skills';
import {
  formatTaskContextReminder,
  type TaskStorePort,
} from '@ema-agent/tasks';
import type { ToolPool } from '@ema-agent/tools';
import type { RequestDegradationNotice } from '@ema-agent/turn';
import type { TurnInput } from './types.js';

export type TurnContextEvent =
  | ContextRuntimeEvent
  | MemoryRecallEvent
  | NarrativeEvent;

export interface TurnContextBuilderDeps {
  readonly session: SessionStore;
  readonly memory?: MemoryRecallPort;
  readonly tasks?: TaskStorePort;
  readonly narrative?: NarrativeClient;
  readonly compactor?: ContextCompactor;
}

export interface TurnContextPreparation {
  readonly turn: Turn;
  readonly input: TurnInput;
  readonly signal: AbortSignal;
  readonly emit?: (event: TurnContextEvent) => void;
}

export interface TurnContextAssembly {
  readonly history: readonly ModelMessage[];
  readonly currentTurn: readonly ModelMessage[];
  readonly scratchpadContext?: string;
  readonly mailboxMessages: readonly string[];
  readonly activeSkills: readonly ActivatedSkill[];
  readonly toolPool: ToolPool;
  readonly forceCompaction: boolean;
  readonly emit?: (event: TurnContextEvent) => void;
}

export interface TurnContext {
  /** AgentLoop 会在同一数组上追加 Assistant 与 Tool 消息。 */
  readonly messages: ModelMessage[];
  readonly historyMessageCount: number;
  readonly readableUserInput: string;
  readonly degradation?: RequestDegradationNotice;
  readonly narrativeTimelines: readonly NarrativeRecallTimeline[];
  /** 最近一次 assemble 的分类估算;llmCallId 由 RootAgentExecution 在发事件时补。 */
  readonly usageEstimate: ContextUsageEstimate | null;
  assemble(request: TurnContextAssembly): Promise<ModelContextSnapshot>;
}

/**
 * Builder 只持有 Context 领域真正需要的服务。prepare() 返回的对象冻结本轮
 * Prompt、模型能力和基础贡献，后续 Agent 迭代只提交变化的消息与运行态投影。
 */
export class TurnContextBuilder {
  private readonly assembler = new ContextAssembler();

  constructor(private readonly deps: TurnContextBuilderDeps) {}

  async prepare(request: TurnContextPreparation): Promise<TurnContext> {
    const { turn, input, signal, emit } = request;
    const { providerId, model, capabilities } = input.model;
    const readableUserInput = toReadableUserInput(input.userInput);

    if (Array.isArray(input.userInput)) {
      const issues = validateCurrentContent(input.userInput, capabilities);
      if (issues.length > 0) {
        throw new LlmModelCapabilityError(providerId, model, issues);
      }
    }

    const historyView = prepareHistoricalMessageView(
      buildModelMessages(this.deps.session.loadHistory(turn.sessionId)),
      capabilities,
    );
    const degradation = historyView.actions.length > 0
      ? {
          attempt: 1,
          reason: '历史消息包含当前模型不支持或能力未知的媒体，已创建只读兼容视图',
          removed: [...new Set(historyView.actions.map((action) => action.modality))],
          replacements: ['placeholder'],
        } satisfies RequestDegradationNotice
      : undefined;

    const baseContributions: ContextContribution[] = [];
    const [narrativeResult, memoryResult] = await Promise.allSettled([
      this.prepareNarrativeContribution(
        turn,
        readableUserInput,
        signal,
        emit,
      ),
      this.prepareMemoryContribution(
        turn,
        readableUserInput,
        signal,
        emit,
      ),
    ]);
    if (signal.aborted) {
      const rejected = [narrativeResult, memoryResult].find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      throw signal.reason ?? rejected?.reason ?? new DOMException(
        'Turn context preparation was aborted.',
        'AbortError',
      );
    }
    if (narrativeResult.status === 'rejected') throw narrativeResult.reason;
    if (memoryResult.status === 'rejected') throw memoryResult.reason;

    // 两路召回可以并行完成，但 Prompt 插入顺序必须保持确定性。
    const narrativeTimelines = narrativeResult.value.timelines;
    if (narrativeResult.value.contribution) {
      baseContributions.push(narrativeResult.value.contribution);
    }
    if (memoryResult.value) baseContributions.push(memoryResult.value);

    if (turn.executionProfile === 'work' && this.deps.tasks) {
      const tasks = this.deps.tasks.takeContextReminder(turn.sessionId);
      if (tasks.length > 0) {
        baseContributions.push({
          id: `tasks.reminder.${Math.max(...tasks.map((task) => task.version))}`,
          source: 'tasks',
          placement: 'beforeCurrentTurn',
          message: {
            role: 'user',
            content: formatTaskContextReminder(tasks),
          },
        });
      }
    }

    const modelUserInput = typeof input.userInput === 'string'
      ? input.userInput
      : input.userInput.map((part) => ({ ...part })) as UserBlock[];
    const messages: ModelMessage[] = [
      ...historyView.messages,
      { role: 'user', content: modelUserInput },
    ];
    const frozenContributions = baseContributions.map((contribution) =>
      structuredClone(contribution)
    );
    let latestUsageEstimate: ContextUsageEstimate | null = null;

    return {
      messages,
      historyMessageCount: historyView.messages.length,
      readableUserInput,
      degradation,
      narrativeTimelines,
      get usageEstimate() {
        return latestUsageEstimate;
      },
      assemble: (assembly) => this.assemble(
        turn,
        input,
        signal,
        frozenContributions,
        assembly,
        (estimate) => { latestUsageEstimate = estimate; },
      ),
    };
  }

  private async prepareNarrativeContribution(
    turn: Turn,
    readableUserInput: string,
    signal: AbortSignal,
    emit?: (event: TurnContextEvent) => void,
  ): Promise<{
    timelines: readonly NarrativeRecallTimeline[];
    contribution?: ContextContribution;
  }> {
    if (
      turn.narrativePolicy !== 'always'
      || !readableUserInput
      || !this.deps.narrative
    ) {
      return { timelines: [] };
    }

    try {
      const recalled = await prepareNarrativeRecall(this.deps.narrative, {
        sessionId: turn.sessionId,
        turnId: turn.id,
        userInput: readableUserInput,
        signal,
        emit,
      });
      return {
        timelines: recalled.timelines,
        ...(recalled.contextText
          ? {
              contribution: {
                id: 'narrative.recall',
                source: 'narrative',
                placement: 'beforeCurrentTurn',
                message: {
                  role: 'user',
                  content:
                    '[NARRATIVE CONTEXT - do not quote verbatim; use as background]\n\n'
                    + recalled.contextText,
                },
              } satisfies ContextContribution,
            }
          : {}),
      };
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      if (!(error instanceof NarrativeClientError)) throw error;
      // Narrative Recall 自己发布整体失败事件；always 策略只负责降级为空上下文。
      return { timelines: [] };
    }
  }

  private async prepareMemoryContribution(
    turn: Turn,
    readableUserInput: string,
    signal: AbortSignal,
    emit?: (event: TurnContextEvent) => void,
  ): Promise<ContextContribution | undefined> {
    if (!this.deps.memory) return undefined;

    // Memory 是辅助贡献：存储或召回失败只降级为空贡献，不能让 Turn 起步失败。
    try {
      const recalled = await this.deps.memory.prepareRecallContribution({
        sessionId: turn.sessionId,
        turnId: turn.id,
        executionProfile: turn.executionProfile,
        narrativePolicy: turn.narrativePolicy,
        userInput: readableUserInput,
        signal,
        emit,
      });
      return recalled.contribution ?? undefined;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      emit?.({
        type: 'memory_recall_unavailable',
        sessionId: turn.sessionId,
        turnId: turn.id,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
      return undefined;
    }
  }

  private async assemble(
    turn: Turn,
    input: TurnInput,
    signal: AbortSignal,
    baseContributions: readonly ContextContribution[],
    request: TurnContextAssembly,
    publishEstimate: (estimate: ContextUsageEstimate) => void,
  ): Promise<ModelContextSnapshot> {
    const contributions: ContextContribution[] = baseContributions.map(
      (contribution) => structuredClone(contribution),
    );
    if (request.scratchpadContext) {
      contributions.push({
        id: 'scratchpad.current',
        source: 'scratchpad',
        placement: 'afterCurrentTurn',
        message: { role: 'user', content: request.scratchpadContext },
      });
    }
    request.mailboxMessages.forEach((content, index) => {
      contributions.push({
        id: `mailbox.${index}`,
        source: 'mailbox',
        placement: 'afterCurrentTurn',
        message: { role: 'user', content: `[Coordinator]: ${content}` },
      });
    });

    const activeSkillContext = renderActiveSkillContext(request.activeSkills);
    const assemblyInput = {
      prompt: input.prompt,
      environment: buildRuntimeEnvironmentSnapshot({
        providerId: input.model.providerId,
        model: input.model.model,
        workspaceRoot: input.workspaceRoot,
      }),
      history: request.history,
      currentTurn: request.currentTurn,
      contributions,
      postCompactionRestoreContributions: activeSkillContext
        ? [{
            id: 'skills.active',
            source: 'skills' as const,
            placement: 'beforeCurrentTurn' as const,
            message: { role: 'user' as const, content: activeSkillContext },
          }]
        : [],
      toolPool: request.toolPool,
    };

    if (!this.deps.compactor) {
      const snapshot = await this.assembler.assemble(assemblyInput);
      publishEstimate(computeContextUsage({
        prompt: input.prompt,
        toolPool: request.toolPool,
        history: snapshot.history,
        currentTurn: request.currentTurn,
        contributions,
        restoreContributions: assemblyInput.postCompactionRestoreContributions,
        contextWindow: input.model.capabilities.contextWindow ?? 200_000,
      }));
      return snapshot;
    }

    const snapshot = await this.assembler.assembleCompacted(
      assemblyInput,
      async (view, options) => {
        const result = await this.deps.compactor!.compact({
          sessionId: turn.sessionId,
          turnId: turn.id,
          executionProfile: turn.executionProfile,
          narrativePolicy: turn.narrativePolicy,
          messages: [...view.historyMessages],
          prefixMessages: view.prefixMessages,
          suffixMessages: view.suffixMessages,
          requiredRestoreMessages: view.requiredRestoreMessages,
          tools: view.tools,
          force: options?.force,
          modelContextWindow: input.model.capabilities.contextWindow ?? 200_000,
          modelMaxOutputTokens: input.model.capabilities.maxOutput,
          providerId: input.model.providerId,
          model: input.model.model,
          signal,
          emit: request.emit,
          settings: input.settings.contextCompaction,
        });
        return result.messages;
      },
      { force: request.forceCompaction },
    );
    publishEstimate(computeContextUsage({
      prompt: input.prompt,
      toolPool: request.toolPool,
      history: snapshot.history,
      currentTurn: request.currentTurn,
      contributions,
      restoreContributions: assemblyInput.postCompactionRestoreContributions,
      contextWindow: input.model.capabilities.contextWindow ?? 200_000,
    }));
    return snapshot;
  }
}

function toReadableUserInput(input: TurnInput['userInput']): string {
  if (typeof input === 'string') return input;
  return input
    .filter((part): part is Extract<(typeof input)[number], { type: 'text' }> =>
      part.type === 'text'
    )
    .map((part) => part.text)
    .join('\n');
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return error instanceof Error && error.name === 'AbortError';
}
