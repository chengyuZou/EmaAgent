// 为一个根 Turn 冻结工具能力，并统一管理权限执行器、子 Agent 与终态收口。

import type { AgentRunId, SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import type { HookBus } from '@ema-agent/hooks';
import type {
  KnowledgeSearchPort,
  KbSearchResult,
} from '@ema-agent/knowledge';
import type { LanguageModel, Message as ModelMessage } from '@ema-agent/llm';
import {
  NarrativeClientError,
  prepareNarrativeRecall,
  type NarrativeClient,
  type NarrativeRecallResult,
  type NarrativeSearchPort,
} from '@ema-agent/narrative';
import type {
  AskPermissionFn,
  PermissionContext,
  PermissionEngine,
  PermissionStreamEvent,
} from '@ema-agent/permission';
import type { CommandRunnerPort } from '@ema-agent/sandbox';
import type { SessionStore, Turn } from '@ema-agent/session';
import {
  ActiveSkillState,
  type ActivatedSkill,
  type SkillRunnerPort,
} from '@ema-agent/skills';
import type { TaskStorePort } from '@ema-agent/tasks';
import type { KbAssetScope } from '@ema-agent/turn';
import {
  ToolExecutionRuntime,
  type BackgroundProcessPort,
  type AskUserRequiredEvent,
  type ReadFileState,
  type ToolExecutionJournalPort,
  type ToolRegistry,
  type ToolResultStore,
} from '@ema-agent/tools';
import {
  assembleToolPool,
  type BuiltinToolContext,
} from '@ema-agent/tool-builtin';
import {
  buildScratchpadContext,
  createToolLifecycleHooks,
  SubagentSpawner,
  TurnPolicy,
  type AgentRunStorePort,
  type AgentRunTranscriptWriter,
  type ExecutorFactory,
  type SubagentSpawnerDeps,
  type TurnBudget,
} from '@ema-agent/agent';
import {
  awaitUserAnswer,
  type AskUserInteractionPort,
} from './awaitUserAnswer.js';
import { executionProfilePolicy } from './executionProfilePolicy.js';
import type {
  TurnExecutionEvent,
  TurnInput,
} from './types.js';

/** LocalHost 为一次 Turn 绑定 KB 范围时使用的执行入口。 */
export type TurnKnowledgeSearch = (
  query: string,
  topK?: number,
  kbIds?: string[],
  assetScopes?: KbAssetScope[],
  sessionId?: string,
  turnId?: string,
) => Promise<KbSearchResult>;

/** 只有 TurnToolsBuilder 消费的工具执行服务。 */
export interface TurnToolsBuilderDeps {
  readonly session: SessionStore;
  readonly tools: ToolRegistry;
  readonly permission: PermissionEngine;
  readonly hooks: HookBus;
  readonly llm: LanguageModel;
  readonly narrative?: NarrativeClient;
  readonly getCommandRunner?: (
    sessionId: SessionId,
  ) => CommandRunnerPort | undefined;
  readonly buildAsk?: (args: {
    sessionId: SessionId;
    turnId: TurnId;
    toolCallId: ToolCallId;
    emit: (event: PermissionStreamEvent) => void;
  }) => AskPermissionFn;
  readonly askUserInteraction?: AskUserInteractionPort;
  readonly skillRunner?: SkillRunnerPort;
  readonly knowledgeSearch?: TurnKnowledgeSearch;
  readonly getSessionToolResultStore?: (
    sessionId: SessionId,
  ) => ToolResultStore;
  readonly agentRunStore?: AgentRunStorePort;
  readonly agentRunTranscriptWriter?: AgentRunTranscriptWriter;
  readonly taskStore?: TaskStorePort;
  readonly toolExecutionJournal?: ToolExecutionJournalPort;
  readonly backgroundProcesses?: BackgroundProcessPort;
}

export interface TurnToolsPreparation {
  readonly turn: Turn;
  readonly input: TurnInput;
  readonly signal: AbortSignal;
  readonly budget: TurnBudget;
}

export type TurnToolsShutdownReason =
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'hook_aborted'
  | 'finished';

interface TurnEventRelay {
  emit?: (event: TurnExecutionEvent) => void;
}

type TurnToolsRuntimeFactory = (
    pushEvent: (event: TurnExecutionEvent) => void,
    wake: () => void,
  ) => ToolExecutionRuntime<BuiltinToolContext>;

/**
 * 一个根 Turn 的工具能力快照。
 *
 * Manifest、执行器、子 Agent 和动态 Skill 状态必须来自同一次装配；
 * 调用方不能在 AgentLoop 中途重新读取全局 Registry 扩大能力。
 */
export class TurnTools {
  private executor?: ToolExecutionRuntime<BuiltinToolContext>;
  private stopped = false;

  constructor(
    readonly policy: TurnPolicy,
    private readonly activeSkillState: ActiveSkillState,
    private readonly spawner: SubagentSpawner,
    private readonly parentMessages: ModelMessage[],
    private readonly scratchpadDir: string | undefined,
    private readonly relay: TurnEventRelay,
    private readonly runtimeFactory: TurnToolsRuntimeFactory,
  ) {}

  readonly buildExecutor: ExecutorFactory<TurnExecutionEvent> = ({
    pushEv,
    signal,
  }) => {
    this.relay.emit = pushEv;
    const executor = this.runtimeFactory(pushEv, signal);
    this.executor = executor;
    return executor;
  };

  /** Hook 产生的最终请求视图只供 fork 子 Agent 继承，不写回 Session 历史。 */
  updateParentContext(messages: readonly ModelMessage[]): void {
    this.parentMessages.splice(
      0,
      this.parentMessages.length,
      ...messages,
    );
  }

  activeSkills(): readonly ActivatedSkill[] {
    return this.activeSkillState.list();
  }

  readScratchpadContext(): string | undefined {
    if (!this.scratchpadDir) return undefined;
    return buildScratchpadContext(this.scratchpadDir);
  }

  abortAgentRun(agentRunId: AgentRunId): boolean {
    return this.spawner.abortSubagent(agentRunId);
  }

  abortTool(toolCallId: string): boolean {
    return this.executor?.abortTool(toolCallId) ?? false;
  }

  /**
   * 根 Turn 进入终态前先等待工具，再切断事件引用并停止子 Agent。
   * 方法幂等，catch/finally 可以安全重复调用。
   */
  async shutdown(reason: TurnToolsShutdownReason): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    try {
      await this.executor?.shutdown(toolShutdownReason(reason));
    } finally {
      this.relay.emit = undefined;
      await this.spawner.shutdown(subagentShutdownReason(reason));
    }
  }
}

/** 把稳定服务与每 Turn 纯值输入组合成不可扩大的工具快照。 */
export class TurnToolsBuilder {
  constructor(private readonly deps: TurnToolsBuilderDeps) {}

  prepare(request: TurnToolsPreparation): TurnTools {
    const { turn, input, signal, budget } = request;
    const sessionId = turn.sessionId;
    const turnId = turn.id;
    const workspaceRoot = input.workspaceRoot;
    const scratchpadDir = input.scratchpadDir;
    const readFileState = new Map() as ReadFileState;
    const activeSkillState = new ActiveSkillState();
    const parentMessages: ModelMessage[] = [];
    const relay: TurnEventRelay = {};

    const commandRunner = this.deps.getCommandRunner?.(sessionId);
    const knowledgeSearch = this.buildKnowledgeSearch(turn, input);
    const narrativeSearch = this.buildNarrativeSearch(turn, relay);
    const permissionContext: PermissionContext = {
      workspaceRoot,
      sessionId,
      turnId,
      internalPaths: scratchpadDir
        ? { turnScratchpad: scratchpadDir }
        : undefined,
    };

    let parentPolicy: TurnPolicy | undefined;
    const spawnerDeps: SubagentSpawnerDeps = {
      tools: this.deps.tools,
      llm: this.deps.llm,
      permission: this.deps.permission,
      hooks: this.deps.hooks,
      getParentAllowedToolIds: () => {
        if (!parentPolicy) {
          throw new Error('Parent TurnPolicy is not ready');
        }
        return parentPolicy.allowedIds();
      },
      buildAsk: this.deps.buildAsk,
      skillRunner: this.deps.skillRunner,
      agentRunStore: this.deps.agentRunStore,
      agentRunTranscriptWriter: this.deps.agentRunTranscriptWriter,
      toolExecutionJournal: this.deps.toolExecutionJournal,
      backgroundProcesses: this.deps.backgroundProcesses,
    };
    const spawner = new SubagentSpawner(
      spawnerDeps,
      sessionId,
      turnId,
      input.model.providerId,
      input.model.model,
      parentMessages,
      workspaceRoot,
      commandRunner,
      readFileState,
      scratchpadDir,
      scratchpadDir
        ? () => buildScratchpadContext(scratchpadDir)
        : undefined,
      (event) => relay.emit?.(event),
      knowledgeSearch,
      budget,
      activeSkillState,
    );

    const capabilityContext: BuiltinToolContext = {
      sessionId,
      turnId,
      workspaceRoot,
      signal,
      readFileState,
      taskStore: this.deps.taskStore,
      commandRunner,
      skillRunner: this.deps.skillRunner,
      activeSkillState,
      knowledgeSearch,
      narrativeSearch,
      subagentSpawner: spawner,
      scratchpad: scratchpadDir
        ? { dir: scratchpadDir, author: 'main' }
        : undefined,
      askUser: this.buildAskUser(turn, signal),
    };

    const profile = executionProfilePolicy(
      turn.executionProfile,
      input.settings.agent,
    );
    const assembledTools = assembleToolPool(
      this.deps.tools,
      capabilityContext,
    );
    const visibleTools = profile.allowedToolIds === null
      ? assembledTools
      : assembledTools.filter((tool) => profile.allowedToolIds!.has(tool.id));
    const policy = new TurnPolicy(
      this.deps.tools.manifestSnapshot(visibleTools),
      profile.maxIterations,
    );
    parentPolicy = policy;
    const toolContext: BuiltinToolContext = Object.freeze({
      ...capabilityContext,
      toolCapabilities: policy.capabilities(),
    });
    const toolResultStore =
      this.deps.getSessionToolResultStore?.(sessionId);

    const runtimeFactory: TurnToolsRuntimeFactory = (pushEvent, wake) =>
      new ToolExecutionRuntime({
        sessionId,
        turnId,
        allows: (name) => policy.allows(name),
        toolManifest: policy.manifestSnapshot(),
        tools: this.deps.tools,
        permission: this.deps.permission,
        permCtx: permissionContext,
        toolContext,
        lifecycle: createToolLifecycleHooks(this.deps.hooks, pushEvent),
        buildAsk: this.deps.buildAsk,
        pushEv: pushEvent,
        signal: wake,
        toolResultStore,
        toolExecutionJournal: this.deps.toolExecutionJournal,
      });

    return new TurnTools(
      policy,
      activeSkillState,
      spawner,
      parentMessages,
      scratchpadDir,
      relay,
      runtimeFactory,
    );
  }

  private buildKnowledgeSearch(
    turn: Turn,
    input: TurnInput,
  ): KnowledgeSearchPort | undefined {
    const search = this.deps.knowledgeSearch;
    if (!search) return undefined;

    return (query, topK, kbIds) => {
      // Tool 显式给出 kbIds 时覆盖用户选择；否则继承本 Turn 冻结的文档范围。
      const effectiveKbIds = kbIds
        ?? (input.kbIds?.length ? [...input.kbIds] : []);
      const effectiveScopes = kbIds
        ? undefined
        : input.kbAssetScopes?.map((scope) => ({
            kbId: scope.kbId,
            assetIds: [...scope.assetIds],
          }));
      return search(
        query,
        topK,
        effectiveKbIds,
        effectiveScopes,
        turn.sessionId,
        turn.id,
      );
    };
  }

  private buildNarrativeSearch(
    turn: Turn,
    relay: TurnEventRelay,
  ): NarrativeSearchPort | undefined {
    const narrative = this.deps.narrative;
    if (turn.narrativePolicy !== 'auto' || !narrative) {
      return undefined;
    }

    return async (query, signal) => {
      let recalled: NarrativeRecallResult;
      try {
        recalled = await prepareNarrativeRecall(narrative, {
          sessionId: turn.sessionId,
          turnId: turn.id,
          userInput: query,
          signal,
          emit: (event) => relay.emit?.(event),
        });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        if (error instanceof NarrativeClientError) {
          relay.emit?.({
            type: 'narrative_recall_unavailable',
            sessionId: turn.sessionId,
            turnId: turn.id,
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          });
        }
        throw error;
      }

      if (recalled.timelines.length > 0) {
        this.deps.session.appendMessage({
          turnId: turn.id,
          sessionId: turn.sessionId,
          role: 'user',
          kind: 'narrative_context',
          blocks: { timelines: [...recalled.timelines] },
        });
      }
      if (
        recalled.timelines.length === 0
        && recalled.failedTimelineCount > 0
      ) {
        relay.emit?.({
          type: 'narrative_recall_unavailable',
          sessionId: turn.sessionId,
          turnId: turn.id,
          code: 'narrative/unknown',
          message: 'Narrative timelines unavailable - continuing without narrative context',
          retryable: true,
        });
      }
      return recalled;
    };
  }

  private buildAskUser(
    turn: Turn,
    signal: AbortSignal,
  ): BuiltinToolContext['askUser'] {
    const interaction = this.deps.askUserInteraction;
    if (!interaction) return undefined;

    return async (promptId, questions, request) => {
      void questions;
      return awaitUserAnswer({
        promptId,
        request: request as AskUserRequiredEvent,
        turnId: turn.id,
        signal,
        interaction,
      });
    };
  }
}

function toolShutdownReason(reason: TurnToolsShutdownReason): string {
  switch (reason) {
    case 'aborted':
      return 'user_abort';
    case 'hook_aborted':
      return 'hook_abort';
    case 'failed':
      return 'turn_failed';
    case 'completed':
      return 'turn_completed';
    case 'finished':
      return 'turn_finished';
  }
}

function subagentShutdownReason(reason: TurnToolsShutdownReason): string {
  switch (reason) {
    case 'aborted':
      return 'parent_turn_aborted';
    case 'hook_aborted':
    case 'failed':
      return 'parent_turn_failed';
    case 'completed':
      return 'parent_turn_completed';
    case 'finished':
      return 'parent_turn_finished';
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return error instanceof Error && error.name === 'AbortError';
}
