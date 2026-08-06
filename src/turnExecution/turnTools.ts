// 为一个根 Turn 冻结工具能力，并统一管理权限执行器、子 Agent 与终态收口。

import type { AgentRunId, SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import type {
  KnowledgeSearchPort,
} from '@ema-agent/knowledge';
import type { LanguageModel, Message as ModelMessage } from '@ema-agent/llm';
import {
  prepareNarrativeRecall,
  type NarrativeClient,
  type NarrativeRecallResult,
  type NarrativeSearchPort,
} from '@ema-agent/narrative';
import type {
  AskPermissionFn,
  PermissionContext,
  PermissionAuthorizer,
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
import {
  assembleToolPool,
  StreamingToolExecutor,
  type BackgroundProcessPort,
  type AskUserRequiredEvent,
  type ReadFileState,
  type ToolExecutionStatePort,
  type ToolPool,
  type ToolRegistry,
  type ToolResultStore,
  type ToolUseContext,
} from '@ema-agent/tools';
import {
  buildScratchpadContext,
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

/** 只有 TurnToolsBuilder 消费的工具执行服务。 */
export interface TurnToolsBuilderDeps {
  readonly session: SessionStore;
  readonly tools: ToolRegistry;
  readonly permission: PermissionAuthorizer;
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
  readonly knowledgeSearch?: KnowledgeSearchPort;
  readonly getSessionToolResultStore?: (
    sessionId: SessionId,
  ) => ToolResultStore;
  readonly agentRunStore?: AgentRunStorePort;
  readonly agentRunTranscriptWriter?: AgentRunTranscriptWriter;
  readonly taskStore?: TaskStorePort;
  readonly toolExecutionState?: ToolExecutionStatePort;
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
  | 'finished';

interface TurnEventRelay {
  emit?: (event: TurnExecutionEvent) => void;
}

type TurnToolsRuntimeFactory = (
    pushEvent: (event: TurnExecutionEvent) => void,
    wake: () => void,
    toolPool: ToolPool,
  ) => StreamingToolExecutor;

/**
 * 一个根 Turn 的工具能力快照。
 *
 * ToolPool、执行器、子 Agent 和动态 Skill 状态必须来自同一次装配；
 * 调用方不能在 AgentLoop 中途重新读取全局 Registry 扩大能力。
 */
export class TurnTools {
  private executor?: StreamingToolExecutor;
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
    toolPool,
  }) => {
    this.relay.emit = pushEv;
    const executor = this.runtimeFactory(pushEv, signal, toolPool);
    this.executor = executor;
    return executor;
  };

  /** 最终模型请求视图只供 fork 子 Agent 继承，不写回 Session 历史。 */
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

  async prepare(request: TurnToolsPreparation): Promise<TurnTools> {
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
      mode: input.settings.permissionMode,
      workspaceRoot,
      sessionId,
      turnId,
      internalPaths: scratchpadDir
        ? { turnScratchpad: scratchpadDir }
        : undefined,
    };

    let parentPolicy: TurnPolicy | undefined;
    const spawnerDeps: SubagentSpawnerDeps = {
      llm: this.deps.llm,
      permission: this.deps.permission,
      permissionMode: input.settings.permissionMode,
      getParentToolPool: () => {
        if (!parentPolicy) {
          throw new Error('Parent TurnPolicy is not ready');
        }
        return parentPolicy.toolPool();
      },
      buildAsk: this.deps.buildAsk,
      skillRunner: this.deps.skillRunner,
      agentRunStore: this.deps.agentRunStore,
      agentRunTranscriptWriter: this.deps.agentRunTranscriptWriter,
      toolExecutionState: this.deps.toolExecutionState,
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

    const capabilityContext: ToolUseContext = {
      workspaceRoot,
      platform: process.platform,
      readFileState,
      taskStore: this.deps.taskStore,
      commandRunner,
      backgroundProcesses: this.deps.backgroundProcesses,
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
    const visibleToolPool = profile.allowedToolIds === null
      ? assembledTools
      : assembledTools.filter((tool) => profile.allowedToolIds!.has(tool.id));
    const policy = new TurnPolicy(
      visibleToolPool,
      profile.maxIterations,
    );
    parentPolicy = policy;
    const toolContext: ToolUseContext = Object.freeze({
      ...capabilityContext,
      toolCapabilities: policy.capabilities(),
    });
    const toolResultStore =
      this.deps.getSessionToolResultStore?.(sessionId);

    const runtimeFactory: TurnToolsRuntimeFactory = (pushEvent, wake, toolPool) =>
      new StreamingToolExecutor({
        sessionId,
        turnId,
        abortSignal: signal,
        toolPool,
        permission: this.deps.permission,
        permissionContext,
        toolContext,
        buildAsk: this.deps.buildAsk,
        pushEv: pushEvent,
        wake,
        toolResultStore,
        toolExecutionState: this.deps.toolExecutionState,
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

    return ({ query, topK, kbIds }) => {
      // Tool 显式给出 kbIds 时覆盖用户选择；否则继承本 Turn 冻结的文档范围。
      const effectiveKbIds = kbIds
        ?? (input.kbIds?.length ? [...input.kbIds] : []);
      const effectiveScopes = kbIds
        ? undefined
        : input.kbAssetScopes?.map((scope) => ({
            kbId: scope.kbId,
            assetIds: [...scope.assetIds],
          }));
      return search({
        query,
        topK,
        kbIds: effectiveKbIds,
        assetScopes: effectiveScopes,
        sessionId: turn.sessionId,
        turnId: turn.id,
      });
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
      const recalled: NarrativeRecallResult = await prepareNarrativeRecall(
        narrative,
        {
          sessionId: turn.sessionId,
          turnId: turn.id,
          userInput: query,
          signal,
          emit: (event) => relay.emit?.(event),
        },
      );

      if (recalled.timelines.length > 0) {
        this.deps.session.appendMessage({
          turnId: turn.id,
          sessionId: turn.sessionId,
          role: 'user',
          kind: 'narrative_context',
          blocks: { timelines: [...recalled.timelines] },
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
    case 'failed':
      return 'parent_turn_failed';
    case 'completed':
      return 'parent_turn_completed';
    case 'finished':
      return 'parent_turn_finished';
  }
}
