// 创建和管理子 Agent，并处理共享临时数据、取消、能力门禁和事件上报。

import { randomUUID } from 'node:crypto';
import { asAgentRunId, type AgentRunId, type SessionId, type TurnId } from '@ema-agent/ids';
import type {
  ReadFileState,
  BackgroundProcessPort,
  ToolError,
  ToolExecutionStatePort,
  StreamingToolExecutorOptions,
  ToolPool,
  ToolUseContext,
} from '@ema-agent/tools';
import { StreamingToolExecutor } from '@ema-agent/tools';
import type { LanguageModel, Message as ModelMessage } from '@ema-agent/llm';
import type { KnowledgeSearchPort } from '@ema-agent/knowledge';
import type { CommandRunnerPort } from '@ema-agent/sandbox';
import type {
  SubagentRunResult,
  SubagentSpawnOptions,
  SubagentSpawnerPort,
} from '@ema-agent/tool-builtin';
import type { PermissionAuthorizer, PermissionMode } from '@ema-agent/permission';
import type { SkillRunnerPort } from '@ema-agent/skills';
import { AgentRunTranscriptProjection } from './runs/agentRunTranscriptProjection.js';
import type {
  AgentRunStorePort,
  AgentRunTranscriptWriter,
} from './runs/types.js';
import { TurnPolicy } from './policy.js';
import { runAgentLoop, type ExecutorFactory } from './agentLoop.js';
import { TurnBudget } from './turn-budget.js';
import {
  isAgentRunEvent,
  type AgentExecutionEvent,
} from './events.js';
import {
  ActiveSkillState,
} from '@ema-agent/skills';

// ── 子 Agent 调度入口 ─────────────────────────────────────────────────────────
// 负责全部子 Agent 面板事件：
//   subagent_started / subagent_progress / subagent_stream / subagent_completed
//   subagent_failed / subagent_aborted
//
// 子 Agent 工具只预分配 agentRunId 并调用 spawn；模型选择、计时、用量和事件均在此处理。
//
// 每次 spawn 都创建关联父信号的 AbortController；父 Turn 中止会级联取消全部子执行，
// abortSubagent(id) 则只取消指定子 Agent。
//
// AgentRun 在循环开始前写入，退出时推进 complete/fail/cancel。
// 每个子执行都归属一个父 Turn，但绝不冒充该 Turn。

const RESULT_EXCERPT_MAX = 500;   // 工具结果明细预览字符数
const OUTPUT_EXCERPT_MAX = 200;   // 子 Agent 完成摘要字符数

/** 子 Agent 循环真正消费的依赖，不继承根 Turn 的 Session、情绪或 Context 能力。 */
export interface SubagentSpawnerDeps {
  llm: LanguageModel;
  permission: PermissionAuthorizer;
  /** 子 Agent 必须继承父 Turn 冻结的权限模式，不能自行升级。 */
  permissionMode: PermissionMode;
  /** spawn 瞬间读取父 Agent 的当前 ToolPool，Skill 收窄会沿任务树传播。 */
  getParentToolPool: () => ToolPool;
  buildAsk?: StreamingToolExecutorOptions['buildAsk'];
  skillRunner?: SkillRunnerPort;
  agentRunStore?: AgentRunStorePort;
  agentRunTranscriptWriter?: AgentRunTranscriptWriter;
  toolExecutionState?: ToolExecutionStatePort;
  backgroundProcesses?: BackgroundProcessPort;
}

export class SubagentSpawner implements SubagentSpawnerPort {
  // 活跃执行按 agentRunId 索引，供单独取消。
  private readonly activeSubagents   = new Map<AgentRunId, AbortController>();
  // 后台执行按 agentRunId 保存结果 Promise，供后续等待。
  private readonly backgroundSpawns  = new Map<AgentRunId, Promise<SubagentRunResult>>();
  // 邮箱按 agentRunId 保存尚未投递的协调消息。
  private readonly pendingMessages   = new Map<AgentRunId, string[]>();
  private stoppingReason: string | undefined;

  constructor(
    private readonly deps:                  SubagentSpawnerDeps,
    private readonly parentSessionId:       string,
    private readonly parentTurnId:          string,   // 父 Agent 的 Turn，不是子执行 ID
    private readonly parentProviderId:      string,
    private readonly parentModel:           string,
    private readonly parentMessages:        ModelMessage[],
    private readonly workspaceRoot:         string,
    private readonly commandRunner:         CommandRunnerPort | undefined,
    private readonly parentReadFileState:   ReadFileState,
    private readonly scratchpadDir?:        string,
    private readonly getScratchpadContext?: () => string | undefined,
    private readonly parentEmit?:           (ev: AgentExecutionEvent) => void,
    private readonly kbSearch?:             KnowledgeSearchPort,
    private readonly budget:                TurnBudget = new TurnBudget(),
    private readonly parentActiveSkillState: ActiveSkillState = new ActiveSkillState(),
  ) {}

  // ── 后台执行 ─────────────────────────────────────────────────────────────

  spawnBackground(prompt: string, opts: SubagentSpawnOptions, signal: AbortSignal): AgentRunId {
    const agentRunId = opts.agentRunId ?? asAgentRunId(randomUUID());
    const optsWithId: SubagentSpawnOptions = { ...opts, agentRunId };
    // 先建立空邮箱，确保调用方拿到 ID 后可以立即投递消息。
    this.pendingMessages.set(agentRunId, []);
    const p = this.spawn(prompt, optsWithId, signal).finally(() => {
      this.pendingMessages.delete(agentRunId);
    });
    // 即使父循环未调用 awaitBackground，也不能产生未处理 Promise 拒绝。
    // 失败已通过 SSE 上报；真正 await 原 Promise 时仍会按原错误抛出。
    p.catch(() => {});
    this.backgroundSpawns.set(agentRunId, p);
    return agentRunId;
  }

  async awaitBackground(
    agentRunId: AgentRunId,
  ): Promise<SubagentRunResult | null> {
    const p = this.backgroundSpawns.get(agentRunId);
    if (!p) return null;
    try {
      return await p;
    } finally {
      this.backgroundSpawns.delete(agentRunId);
    }
  }

  // ── 邮箱 ─────────────────────────────────────────────────────────────────

  queueMessage(agentRunId: AgentRunId, message: string): boolean {
    const queue = this.pendingMessages.get(agentRunId);
    if (!queue) return false;   // 子 Agent 不存在或已经结束
    queue.push(message);
    return true;
  }

  // ── 单个子 Agent 取消 ─────────────────────────────────────────────────────

  abortSubagent(agentRunId: AgentRunId): boolean {
    const controller = this.activeSubagents.get(agentRunId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** 父 Turn 收口时取消并等待所有未显式 await 的后台子 Agent。 */
  async shutdown(reason: string): Promise<void> {
    this.stoppingReason = reason;
    for (const controller of this.activeSubagents.values()) {
      controller.abort(new Error(reason));
    }
    await Promise.allSettled(this.backgroundSpawns.values());
    this.backgroundSpawns.clear();
    this.pendingMessages.clear();
  }

  // ── 执行 ─────────────────────────────────────────────────────────────────

  async spawn(
    prompt:  string,
    opts:    SubagentSpawnOptions,
    signal:  AbortSignal,
  ): Promise<SubagentRunResult> {
    const releaseBudget = this.budget.enterSubagent();
    const { llm, permission } = this.deps;
    const agentRunId    = opts.agentRunId ?? asAgentRunId(randomUUID());
    const sessionId     = this.parentSessionId as SessionId;
    const parentTurnId  = this.parentTurnId   as TurnId;
    const resolvedModel = opts.model ?? this.parentModel;
    const permCtx       = {
      mode: this.deps.permissionMode,
      workspaceRoot: this.workspaceRoot,
      sessionId,
      turnId: parentTurnId,
      internalPaths: this.scratchpadDir
        ? { turnScratchpad: this.scratchpadDir }
        : undefined,
    };

    const startedAtMs = Date.now();
    const taskId      = opts.taskId;
    const kind        = opts.kind ?? 'subagent';
    const transcriptProjection = this.deps.agentRunTranscriptWriter
      ? new AgentRunTranscriptProjection(this.deps.agentRunTranscriptWriter)
      : undefined;
    const emit = (ev: AgentExecutionEvent): void => {
      if (transcriptProjection && isAgentRunEvent(ev)) {
        const warning = transcriptProjection.apply(ev);
        if (warning) {
          this.parentEmit?.({
            type: 'turn_projection_warning',
            sessionId,
            turnId: parentTurnId,
            ...warning,
          });
        }
      }
      this.parentEmit?.(ev);
    };

    // 子控制器继承父取消信号，也允许只取消当前 AgentRun。
    const childCtrl     = new AbortController();
    const onParentAbort = () => childCtrl.abort();
    signal.addEventListener('abort', onParentAbort, { once: true });
    this.activeSubagents.set(agentRunId, childCtrl);

    // 子 Agent 与父 Turn 在同一工作区和沙箱能力内执行，但拥有独立的可变文件状态。
    // fork 继承父执行已读取文件的快照；fresh 子 Agent 必须自行读取后才能编辑。
    // Task、AskUser 和新的 SubagentSpawner 不注入，递归与用户交互能力由 Context 投影隐藏。
    const readFileState: ReadFileState = kind === 'fork'
      ? new Map(this.parentReadFileState)
      : new Map();
    const activeSkillState = kind === 'fork'
      ? this.parentActiveSkillState.fork()
      : new ActiveSkillState();
    const capabilityContext: ToolUseContext = {
      workspaceRoot:    this.workspaceRoot,
      platform:         process.platform,
      commandRunner:    this.commandRunner,
      backgroundProcesses: this.deps.backgroundProcesses,
      readFileState,
      skillRunner:      this.deps.skillRunner,
      activeSkillState,
      knowledgeSearch:  this.kbSearch,
      scratchpad:       this.scratchpadDir
        ? { dir: this.scratchpadDir, author: `subagent:${agentRunId.slice(0, 8)}` }
        : undefined,
    };
    const childToolPool = this.deps.getParentToolPool().filter(
      (tool) => tool.validateContext(capabilityContext).valid,
    );
    const policy = new TurnPolicy(childToolPool);
    const toolContext: ToolUseContext = Object.freeze({
      ...capabilityContext,
      toolCapabilities: policy.capabilities(),
    });

    // 持久化或启动事件订阅者都可能抛错；循环开始前失败时也必须释放监听和索引。
    try {
      // ── 先持久化子执行，再发送启动事件 ──────────────────────────────────
      this.deps.agentRunStore?.start({
        agentRunId,
        sessionId,
        parentTurnId,
        taskId,
        kind,
        purpose: opts.description,
        providerConfigId: this.parentProviderId,
        modelId: resolvedModel,
      });

      // ── 子 Agent 启动事件 ──────────────────────────────────────────────
      emit({
        type: 'subagent_started',
        sessionId,
        subagentId: agentRunId,
        parentTurnId,
        description:   opts.description,
        model:         resolvedModel,
        kind,
        promptExcerpt: prompt.slice(0, 200),
        startedAtMs,
      });
    } catch (err) {
      signal.removeEventListener('abort', onParentAbort);
      this.activeSubagents.delete(agentRunId);
      releaseBudget();
      throw err;
    }

    // 面板累计指标。
    let currentIteration = 0;
    let toolCallCount    = 0;
    const callStartMs    = new Map<string, number>();  // callId → 开始时间
    const callIdToName   = new Map<string, string>();  // callId → 工具名

    // fork 继承父历史并在尾部设置缓存断点；subagent 只接收自包含任务文本，
    // 用于减少独立工作者的 Token 消耗和上下文串扰。
    let messages: ModelMessage[];
    if (kind === 'subagent') {
      messages = [{ role: 'user', content: prompt }];
    } else {
      const sharedPrefix = this.parentMessages.map((m, i) =>
        i === this.parentMessages.length - 1 ? { ...m, cacheBreakpoint: true as const } : m,
      );
      messages = [...sharedPrefix, { role: 'user', content: prompt }];
    }

    let subagentExecutor: StreamingToolExecutor | undefined;
    const buildExecutor: ExecutorFactory<AgentExecutionEvent> = ({
      pushEv,
      signal: wakeSignal,
      toolPool,
    }) => {
      const executor = new StreamingToolExecutor({
        sessionId,
        turnId:     parentTurnId,
        agentRunId,
        abortSignal: childCtrl.signal,
        toolPool,
        permission,
        permissionContext: permCtx,
        toolContext,
        buildAsk:   this.deps.buildAsk,
        pushEv,
        wake:       wakeSignal,
        toolExecutionState: this.deps.toolExecutionState,
      });
      subagentExecutor = executor;
      return executor;
    };

    let fullText = '';
    let usage    = { inputTokens: 0, outputTokens: 0 };

    try {
      const agentLoop = runAgentLoop<AgentExecutionEvent>({
        messages, policy, buildExecutor, llm,
        providerId:           this.parentProviderId,
        model:                resolvedModel,
        signal:               childCtrl.signal,
        maxIterations:        policy.maxIterations(),
        budget:                this.budget,
        sessionId:            this.parentSessionId,
        turnId:               this.parentTurnId,
        getScratchpadContext: this.getScratchpadContext,
        // 每次 LLM 调用前原子清空邮箱，确保协调消息只在下一轮边界投递一次。
        getMailboxMessages: () => {
          const queue = this.pendingMessages.get(agentRunId);
          if (!queue || queue.length === 0) return [];
          const msgs = [...queue];
          queue.length = 0;
          return msgs;
        },
      });
      let loopStep = await agentLoop.next();
      while (!loopStep.done) {
        const ev = loopStep.value;
        const elapsedMs = Date.now() - startedAtMs;

        switch (ev.type) {

          // ── 新迭代：卡片进度与详情心跳 ─────────────────────────────────
          case 'loop_iteration':
            currentIteration = ev.n;
            emit({
              type: 'subagent_progress',
              sessionId, subagentId: agentRunId,
              iteration:     currentIteration,
              elapsedMs,
              toolCallCount,
            });
            emit({
              type: 'subagent_stream',
              sessionId, subagentId: agentRunId,
              ev: { type: 'iteration', sessionId, subagentId: agentRunId, taskId, n: currentIteration, elapsedMs },
            });
            break;

          // ── 文本流 ─────────────────────────────────────────────────────
          case 'loop_text_delta':
            emit({
              type: 'subagent_stream',
              sessionId, subagentId: agentRunId,
              ev: { type: 'text_delta', sessionId, subagentId: agentRunId, taskId, delta: ev.delta },
            });
            break;

          // ── 推理流 ─────────────────────────────────────────────────────
          case 'loop_thinking_delta':
            emit({
              type: 'subagent_stream',
              sessionId, subagentId: agentRunId,
              ev: { type: 'reasoning_delta', sessionId, subagentId: agentRunId, taskId, delta: ev.delta },
            });
            break;

          // 子 Agent 仍属于父 Turn；兼容降级必须进入同一条结构化 SSE，不能丢在内部循环。
          case 'loop_request_degraded':
            emit({
              type: 'request_degraded',
              sessionId,
              turnId: parentTurnId,
              attempt: ev.attempt,
              reason: `子 Agent ${agentRunId}：${ev.reason}`,
              removed: ev.removed,
              replacements: ev.replacements,
            });
            break;

          // ── 工具调用已派发 ─────────────────────────────────────────────
          case 'loop_tool_complete':
            toolCallCount++;
            callStartMs.set(ev.callId, Date.now());
            callIdToName.set(ev.callId, ev.name);
            emit({
              type: 'subagent_stream',
              sessionId, subagentId: agentRunId,
              ev: {
                type: 'tool_call', sessionId, subagentId: agentRunId, taskId,
                callId: ev.callId, name: ev.name, args: ev.args, iteration: currentIteration,
              },
            });
            break;

          // ── 工具执行器转发的结果 ────────────────────────────────────────
          case 'loop_relay': {
            const inner = ev.ev;
            if (inner.type === 'tool_result') {
              const name       = callIdToName.get(inner.callId) ?? 'unknown';
              const durationMs = callStartMs.has(inner.callId)
                ? Date.now() - callStartMs.get(inner.callId)!
                : 0;
              callStartMs.delete(inner.callId);

              const isError = !!inner.error;
              const raw     = isError
                ? inner.error!.message
                : typeof inner.output === 'string'
                  ? inner.output
                  : JSON.stringify(inner.output ?? '');
              const excerpt = raw.slice(0, RESULT_EXCERPT_MAX);
              const bytes   = Buffer.byteLength(raw, 'utf8');

              emit({
                type: 'subagent_stream',
                sessionId, subagentId: agentRunId,
                ev: {
                  type: 'tool_result',
                  sessionId, subagentId: agentRunId, taskId,
                  callId: inner.callId,
                  name,
                  excerpt,
                  bytes,
                  isError,
                  error:     inner.error as ToolError | undefined,
                  durationMs,
                },
              });
            }
            break;
          }

        }
        loopStep = await agentLoop.next();
      }

      const loopOutcome = loopStep.value;
      fullText = loopOutcome.fullText;
      usage = {
        inputTokens: loopOutcome.state.usage.inputTokens,
        outputTokens: loopOutcome.state.usage.outputTokens,
      };

      // AgentLoop 以 aborted 结果正常收束；Spawner 必须映射成子执行取消。
      if (childCtrl.signal.aborted) {
        throw new Error(signal.aborted ? 'Parent turn aborted' : 'Sub-agent aborted by user');
      }

      // ── 子 Agent 完成事件 ──────────────────────────────────────────────
      const durationMs = Date.now() - startedAtMs;
      emit({
        type: 'subagent_completed',
        sessionId, subagentId: agentRunId,
        outputExcerpt:  fullText.slice(0, OUTPUT_EXCERPT_MAX),
        iterationCount: currentIteration,
        toolCallCount,
        stats: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, durationMs },
      });

      this.deps.agentRunStore?.complete(agentRunId, {
        iterations:   currentIteration,
        toolCallCount,
        inputTokens:  usage.inputTokens,
        outputTokens: usage.outputTokens,
        outputExcerpt: fullText.slice(0, OUTPUT_EXCERPT_MAX),
      });

      return { agentRunId, output: fullText, usage };

    } catch (err) {
      const elapsedMs = Date.now() - startedAtMs;
      // 子信号同时覆盖父级联取消与单独取消，需再检查父信号区分原因。
      const isAbort = childCtrl.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);

      // 子 Agent 也必须遵守 Turn 终态晚于工具终态的约束。
      await subagentExecutor?.shutdown(isAbort ? 'subagent_aborted' : 'subagent_failed');

      if (isAbort) {
        const reason = signal.aborted
          ? 'parent_aborted'
          : this.stoppingReason ?? 'user_aborted';
        emit({ type: 'subagent_aborted', sessionId, subagentId: agentRunId, reason, elapsedMs });
        this.deps.agentRunStore?.cancel(agentRunId, reason);
      } else {
        emit({
          type: 'subagent_failed',
          sessionId,
          subagentId: agentRunId,
          error: message,
          atIteration: currentIteration,
          elapsedMs,
        });
        this.deps.agentRunStore?.fail(agentRunId, message);
      }

      throw err;

    } finally {
      const warning = transcriptProjection?.flush();
      if (warning) {
        this.parentEmit?.({
          type: 'turn_projection_warning',
          sessionId,
          turnId: parentTurnId,
          ...warning,
        });
      }
      signal.removeEventListener('abort', onParentAbort);
      this.activeSubagents.delete(agentRunId);
      releaseBudget();
    }
  }
}
