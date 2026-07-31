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
import type { ToolManifestSnapshot } from '@ema-agent/tools';
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
  readonly toolManifest: ToolManifestSnapshot;
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
    let narrativeTimelines: readonly NarrativeRecallTimeline[] = [];

    if (
      turn.narrativePolicy === 'always'
      && readableUserInput
      && this.deps.narrative
    ) {
      try {
        const recalled = await prepareNarrativeRecall(this.deps.narrative, {
          sessionId: turn.sessionId,
          turnId: turn.id,
          userInput: readableUserInput,
          signal,
          emit,
        });
        narrativeTimelines = recalled.timelines;
        if (recalled.contextText) {
          baseContributions.push({
            id: 'narrative.recall',
            source: 'narrative',
            placement: 'beforeCurrentTurn',
            message: {
              role: 'user',
              content:
                '[NARRATIVE CONTEXT - do not quote verbatim; use as background]\n\n'
                + recalled.contextText,
            },
          });
        }
        if (
          recalled.timelines.length === 0
          && recalled.failedTimelineCount > 0
        ) {
          emit?.({
            type: 'narrative_recall_unavailable',
            sessionId: turn.sessionId,
            turnId: turn.id,
            code: 'narrative/unknown',
            message: 'Narrative timelines unavailable - continuing without narrative context',
            retryable: true,
          });
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        if (!(error instanceof NarrativeClientError)) throw error;
        emit?.({
          type: 'narrative_recall_unavailable',
          sessionId: turn.sessionId,
          turnId: turn.id,
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        });
      }
    }

    if (this.deps.memory) {
      // Memory 召回是辅助贡献：存储或召回失败只降级为空贡献，
      // 不能让 Turn 起步失败（与上方 Narrative 分支同一降级标准）。
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
        if (recalled.contribution) baseContributions.push(recalled.contribution);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        emit?.({
          type: 'memory_recall_unavailable',
          sessionId: turn.sessionId,
          turnId: turn.id,
          error: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }
    }

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
      toolManifest: request.toolManifest,
    };

    if (!this.deps.compactor) {
      const snapshot = await this.assembler.assemble(assemblyInput);
      publishEstimate(computeContextUsage({
        prompt: input.prompt,
        toolManifest: request.toolManifest,
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
      toolManifest: request.toolManifest,
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
