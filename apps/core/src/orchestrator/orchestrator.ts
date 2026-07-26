// 接收一次 Turn 请求，选择执行方式，并把执行过程整理成前端需要的事件流。

import type {
  AppBindings } from '../wiring/index.js';
import type {
  TurnId,
  SessionId,
} from '@ema-agent/ids';
import type {
  ExecutionProfile,
  KbAssetScope,
  NarrativePolicy,
  TurnTrigger,
} from '@ema-agent/turn';
import type { ThinkingMode } from '@ema-agent/llm';
import type { LlmContentPart } from '@ema-agent/llm';
import { llmProviderErrorCode } from '@ema-agent/llm';
import type { Attachment, AttachmentInput } from '@ema-agent/attachment';
import {
  asSessionId,
} from '@ema-agent/ids';
import type {
  RequestDegradationNotice,
  TurnFailureCode,
} from '@ema-agent/turn';
import type { EmaStreamEvent } from '@ema-agent/events';
import { ConversationEngine } from '@ema-agent/conversation';
import {
  TurnExecutor,
  TurnPreparationError,
  type TurnExecutionPlan,
  type TurnOutcome,
} from '@ema-agent/turn-execution';
import { TtsCoordinator }     from '@ema-agent/tts';
import type { FinalizedAudio } from '@ema-agent/tts';
import { SettingsRepo } from '@ema-agent/storage';
import { resolveVoice, ensureVoiceUri, VoiceUriCache } from '../wiring/providers/tts.js';
import { ensureSessionLayout, scratchpadTurnDir } from '../storage-locations/index.js';
import type { AttachmentReferenceBlock, MessageBlocks, Turn } from '@ema-agent/session';
import type { TurnFailurePhase } from '@ema-agent/hooks';
import { prepareImagesForModel, replaceImageParts } from './media-compatibility.js';
import { buildPromptSnapshot } from '@ema-agent/prompts';
import { formatTaskContextReminder } from '@ema-agent/tasks';

export interface TurnResult {
  turnId: TurnId;
  events: AsyncIterable<EmaStreamEvent>;
  completion?: Promise<TurnOutcome>;
}

export interface TurnRequest {
  sessionId:        string;
  trigger:          TurnTrigger;
  executionProfile: ExecutionProfile;
  narrativePolicy:  NarrativePolicy;
  userInput:        string;
  contentParts?:    LlmContentPart[];
  /** Core 内部落库投影，不属于 HTTP 请求字段。 */
  persistedUserInput?: MessageBlocks;
  /** Per-turn file attachments from the frontend. Persisted and resolved before engine dispatch. */
  attachmentInputs?: AttachmentInput[];
  /** provider_configs.id — 和 model 成对使用，前端选择器选的是 (provider, model) 组合。 */
  providerId?:      string;
  model?:           string;
  /** KB ids the user selected in the chat picker (turn-level search scope). */
  kbIds?:           string[];
  /** Per-KB document scopes from the chat picker. */
  kbAssetScopes?:   KbAssetScope[];
  /**
   * Whether to spawn a TtsCoordinator for this turn. Defaults to false —
   * the frontend opts in per turn (after the user toggles the speaker icon).
   * When false, no TTS synthesis happens and no `tts_chunk` events emit.
   */
  ttsEnabled?:  boolean;
  /** User-requested thinking mode. Only sent when the model supports reasoning and the user toggled it on. */
  thinking?:    ThinkingMode;
}

interface PreparedCoreTurnRequest {
  request: TurnRequest & { persistedUserInput: MessageBlocks };
  requestDegradations: RequestDegradationNotice[];
}

/**
 * Optional callbacks the route layer wires in. The orchestrator can't import
 * routes/turns.ts (would be circular), so we go through this thin seam.
 */
export interface OrchestratorCallbacks {
  /**
   * Fired after a turn's TTS has finished and the merged audio file is on
   * disk. The route handler uses this to call `eventStore.evictAudioChunks`
   * — releases the in-memory base64 audio chunks once they're replayable
   * from `GET /api/turns/:turnId/audio`.
   *
   * `audioPath` is null if no audio was produced (turn had no TTS, or all
   * sentences errored).
   */
  onAudioFinalized?: (turnId: TurnId, sessionId: SessionId, audio: FinalizedAudio | null) => void;
}

/**
 * Core 迁移期入口：Work 已交给 TurnExecutor，Chat 仍走旧 ConversationEngine。
 * 这里只保留输入准备、TTS 旁路和跨端事件合流，待 Chat 迁移后继续拆除。
 */
export class Orchestrator {
  private readonly conversation: ConversationEngine;
  private readonly turnExecutor: TurnExecutor;
  private readonly callbacks:    OrchestratorCallbacks;
  // Core 迁移期只保留按 turnId 查找取消入口，不再复制 Session 运行注册表。
  private readonly activeTurns = new Map<string, { abort: () => void }>();

  constructor(
    private readonly bindings:   AppBindings,
    callbacks:                   OrchestratorCallbacks = {},
  ) {
    this.callbacks    = callbacks;
    this.conversation = new ConversationEngine(bindings);
    this.turnExecutor = new TurnExecutor({
      session:           bindings.session,
      hooks:             bindings.hooks,
      llm:               bindings.llm,
      modelCapabilities: bindings.modelCapabilities,
      emotion:           bindings.emotion,
      tools:             bindings.tools,
      permission:        bindings.permission,
      getCommandRunner:  bindings.getCommandRunner,
      buildAsk:          bindings.buildAskForTurn,
      askUserInteraction: bindings.askUserRegistry,
      artifactStore:     bindings.artifactStore,
      skillRunner:       bindings.skillRunner,
      kbSearch:          bindings.kbSearch,
      getSessionToolResultStore: bindings.getSessionToolResultStore,
      agentRunStore:     bindings.agentRunStore,
      taskStore:         bindings.taskStore,
      toolExecutionJournal: bindings.toolExecutionJournal,
    });
  }

  /** 请求停止指定 Turn；Turn 已结束或不存在时无操作。 */
  abort(turnId: TurnId): void {
    this.activeTurns.get(turnId as string)?.abort();
  }

  /** 只取消一个子 Agent，不中止父 Turn。 */
  abortSubagent(turnId: TurnId, subagentId: string): void {
    this.turnExecutor.abortAgentRun(turnId as string, subagentId);
  }

  /** 只取消一个运行中的工具调用，不中止父 Turn。 */
  abortTool(turnId: TurnId, callId: string): boolean {
    return this.turnExecutor.abortTool(turnId as string, callId);
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    return request.executionProfile === 'work'
      ? this.runWork(request)
      : this.runChat(request);
  }

  private async runWork(request: TurnRequest): Promise<TurnResult> {
    const sessionId = asSessionId(request.sessionId);
    ensureSessionLayout(this.bindings.activeDataDir, sessionId as string);

    const handle = this.turnExecutor.start({
      sessionId,
      triggerType: request.trigger.type,
      executionProfile: request.executionProfile,
      narrativePolicy: request.narrativePolicy,
      userInput: request.userInput,
      prepare: async ({ turn, signal }) => {
        const prepared = await this.prepareCoreTurnRequest(request, turn, signal);
        return this.buildWorkExecutionPlan(
          prepared.request,
          turn,
          prepared.requestDegradations,
        );
      },
    });
    this.activeTurns.set(handle.turnId as string, { abort: handle.abort });

    // TTS 仍由 Core 负责，不取得根 Turn 的取消控制器。终态到达或流关闭时
    // 单独取消旁路音频，避免把媒体生命周期反向塞进 TurnExecutor。
    const ttsController = new AbortController();
    const events = await this.mergeWithTts(
      request,
      handle.turnId,
      sessionId,
      ttsController.signal,
      handle.events,
      () => {
        ttsController.abort();
        this.activeTurns.delete(handle.turnId as string);
      },
    );

    return {
      turnId: handle.turnId,
      events,
      completion: handle.completion,
    };
  }

  private async runChat(request: TurnRequest): Promise<TurnResult> {
    const sessionId = asSessionId(request.sessionId);
    // 附件或音频写入前建立 Session 目录；递归创建可重复调用。
    ensureSessionLayout(this.bindings.activeDataDir, sessionId as string);
    const startInput = {
      sessionId,
      triggerType: request.trigger.type,
      executionProfile: request.executionProfile,
      narrativePolicy: request.narrativePolicy,
      userInput: request.userInput,
    };
    const { turn, signal } = this.bindings.session.startTurn(startInput);
    const turnId = turn.id;
    this.activeTurns.set(turnId as string, {
      abort: () => this.bindings.session.requestAbort(sessionId),
    });

    let preparedRequest: PreparedCoreTurnRequest;
    try {
      preparedRequest = await this.prepareCoreTurnRequest(request, turn, signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.reportTurnFailure(
          turn,
          err instanceof TurnPreparationError
            ? err.code
            : 'turn/attachment_failed',
          message,
          'setup',
        );
      } catch { /* fall through to clear */ }
      this.bindings.session.clearRunning(sessionId);
      this.activeTurns.delete(turnId as string);
      throw err;
    }

    const {
      request: resolvedRequest,
      requestDegradations,
    } = preparedRequest;

    // Chat 迁移期仍由 Core 创建旧 Conversation 事件流；任何同步失败都必须释放锁。
    let engineEvents: AsyncIterable<EmaStreamEvent>;
    try {
      engineEvents = this.engineStreamFor(
        resolvedRequest,
        turn,
        signal,
        sessionId,
        requestDegradations,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 即使终态持久化失败，也必须继续释放 Session 运行锁。
      try {
        await this.reportTurnFailure(turn, 'turn/setup_failed', message, 'setup');
      } catch { /* fall through to clear */ }
      this.bindings.session.clearRunning(sessionId);
      this.activeTurns.delete(turnId as string);
      throw err;
    }

    const events = await this.mergeWithTts(
      request,
      turnId,
      sessionId,
      signal,
      engineEvents,
      () => {
        this.bindings.session.clearRunning(sessionId);
        this.activeTurns.delete(turnId as string);
      },
    );

    return { turnId, events };
  }

  /**
   * TTS 是 Turn 输出的旁路增强。终态事件必须等音频收尾后最后发送，
   * TTS 初始化或归档失败不得改变模型执行终态。
   */
  private async mergeWithTts(
    request: TurnRequest,
    turnId: TurnId,
    sessionId: ReturnType<typeof asSessionId>,
    signal: AbortSignal,
    engineEvents: AsyncIterable<EmaStreamEvent>,
    onFinally: () => void,
  ): Promise<AsyncIterable<EmaStreamEvent>> {
    const ttsQueue: EmaStreamEvent[] = [];
    let ttsSignal = armSignal();
    const pushTts = (event: EmaStreamEvent): void => {
      ttsQueue.push(event);
      ttsSignal.fire();
    };

    let coordinator: TtsCoordinator | null = null;
    try {
      coordinator = await this.maybeBuildCoordinator(
        request,
        turnId,
        sessionId,
        signal,
        pushTts,
      );
    } catch (error) {
      pushTts({
        type: 'tts_warning',
        sessionId,
        turnId,
        code: 'tts/setup_failed',
        severity: 'warn',
        message: `TTS 初始化失败，本轮无语音：${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const { callbacks } = this;
    return (async function* () {
      try {
        while (ttsQueue.length > 0) yield ttsQueue.shift()!;

        let pendingTurnDone: EmaStreamEvent | null = null;
        for await (const event of mergeStreams(engineEvents, coordinator, ttsQueue, () => {
          ttsSignal = armSignal();
          return ttsSignal.promise;
        })) {
          if (
            event.type === 'turn_completed'
            || event.type === 'turn_failed'
            || event.type === 'turn_aborted'
          ) {
            pendingTurnDone = event;
            continue;
          }
          yield event;
        }

        if (coordinator && pendingTurnDone?.type === 'turn_completed') {
          const { audio } = await coordinator.finish();
          while (ttsQueue.length > 0) yield ttsQueue.shift()!;
          callbacks.onAudioFinalized?.(turnId, sessionId, audio);
        } else if (coordinator) {
          await coordinator.abort();
          ttsQueue.length = 0;
          callbacks.onAudioFinalized?.(turnId, sessionId, null);
        }

        if (pendingTurnDone) yield pendingTurnDone;
      } catch (error) {
        if (coordinator) {
          await coordinator.abort();
          callbacks.onAudioFinalized?.(turnId, sessionId, null);
        }
        throw error;
      } finally {
        onFinally();
      }
    })();
  }

  /**
   * 附件仍由 Core 的受限文件能力准备，但只产出本轮执行输入，不自行推进 Turn。
   * 图片能力降级和直接 contentParts 共用同一条模型门禁。
   */
  private async prepareCoreTurnRequest(
    request: TurnRequest,
    turn: Turn,
    signal: AbortSignal,
  ): Promise<PreparedCoreTurnRequest> {
    const sessionId = turn.sessionId;
    const turnId = turn.id;
    let contentParts = request.contentParts;
    let userInput = request.userInput;
    let storedAttachments: Attachment[] = [];
    const requestDegradations: RequestDegradationNotice[] = [];

    try {
      if (request.attachmentInputs?.length) {
        storedAttachments = this.bindings.attachmentStore.addAll(
          request.attachmentInputs,
          turnId,
          sessionId,
        );
        const resolved = this.bindings.attachmentStore.resolveForPrompt(storedAttachments);

        if (resolved.imageParts.length > 0 || resolved.promptLines) {
          const parts: LlmContentPart[] = [...resolved.imageParts];
          if (contentParts?.length) {
            parts.push(...contentParts);
          } else {
            parts.push({ type: 'text', text: userInput });
          }
          if (resolved.promptLines) {
            parts.push({ type: 'text', text: resolved.promptLines });
          }
          contentParts = parts;
          userInput = '';
        }
      }

      const imageParts = contentParts?.filter(
        (part) => part.type === 'image_data' || part.type === 'image_url',
      ) ?? [];
      if (imageParts.length > 0) {
        const resolvedLlm = this.resolveLlmForTurn(request);
        if (!resolvedLlm.providerId || !resolvedLlm.model) {
          throw new Error('provider/not_configured');
        }
        const fallback = await prepareImagesForModel({
          capabilitiesFor: (providerId, model) =>
            this.bindings.modelCapabilities.resolve({ providerId, model }),
          visionBinding: () => this.bindings.modelBindings.get('vision'),
          describeImages: async ({
            providerId,
            model,
            inputs,
            signal: visionSignal,
          }) => {
            const result = await this.bindings.vision.extract({
              providerId,
              model,
              task: 'caption',
              inputs,
              context: {
                caller: 'turn_attachment',
                sessionId: sessionId as string,
                turnId: turnId as string,
              },
              signal: visionSignal,
            });
            return result.text;
          },
        }, resolvedLlm.providerId, resolvedLlm.model, imageParts, signal);
        contentParts = replaceImageParts(contentParts ?? [], fallback.parts);
        if (fallback.degradation) requestDegradations.push(fallback.degradation);
      }
    } catch (error) {
      const providerCode = llmProviderErrorCode(error);
      const code = providerCode === 'provider/model_capability_unsupported'
        ? providerCode
        : 'turn/attachment_failed';
      throw new TurnPreparationError(
        code,
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }

    const resolvedRequest = contentParts !== request.contentParts || userInput !== request.userInput
      ? { ...request, contentParts, userInput }
      : request;
    const persistedUserInput = buildPersistedUserInput(
      contentParts?.length ? contentParts : userInput,
      storedAttachments,
    );
    return {
      request: { ...resolvedRequest, persistedUserInput },
      requestDegradations,
    };
  }

  private buildWorkExecutionPlan(
    request: TurnRequest & { persistedUserInput: MessageBlocks },
    turn: Turn,
    requestDegradations: RequestDegradationNotice[],
  ): TurnExecutionPlan {
    const sessionId = turn.sessionId;
    const session = this.bindings.session.getSession(sessionId);
    const workspaceRoot = session.workspaceRoot ?? process.cwd();
    const { providerId, model } = this.resolveLlmForTurn(request);
    if (!providerId || !model) {
      throw new TurnPreparationError(
        'provider/not_configured',
        'No LLM provider configured for work profile',
      );
    }

    const contextWindow = this.bindings.providerLlmModels.contextWindowFor(providerId, model)
      ?? this.bindings.modelCapabilities.resolve({ providerId, model }).contextWindow
      ?? 200_000;
    const modelMaxOutputTokens = this.bindings.modelCapabilities.resolve({
      providerId,
      model,
    }).maxOutput;

    return {
      providerId,
      model,
      prompt: buildPromptSnapshot({
        activeCharacter: this.bindings.card.current(),
        executionProfile: request.executionProfile,
        narrativePolicy: request.narrativePolicy,
        extensionContributions: [
          this.bindings.skillRunner.promptContribution(request.executionProfile),
        ].filter((contribution) => contribution !== null),
      }),
      userInput: request.contentParts?.length
        ? request.contentParts
        : request.userInput,
      persistedUserInput: request.persistedUserInput,
      workspaceRoot,
      scratchpadDir: scratchpadTurnDir(
        this.bindings.activeDataDir,
        sessionId,
        turn.id as string,
      ),
      kbIds: request.kbIds,
      kbAssetScopes: request.kbAssetScopes,
      thinking: request.thinking,
      requestDegradations,
      prepareContextContributions: async (contextRequest) => {
        const recalled = await this.bindings.memory.prepareRecallContribution({
          sessionId: contextRequest.sessionId,
          turnId: contextRequest.turnId,
          executionProfile: contextRequest.executionProfile,
          narrativePolicy: contextRequest.narrativePolicy,
          userInput: contextRequest.userInput,
          signal: contextRequest.signal,
        });
        const contributions = recalled.contribution ? [recalled.contribution] : [];
        const tasks = this.bindings.taskStore.takeContextReminder(contextRequest.sessionId);
        if (tasks.length > 0) {
          contributions.push({
            id: `tasks.reminder.${Math.max(...tasks.map((task) => task.version))}`,
            source: 'tasks',
            placement: 'beforeCurrentTurn',
            message: {
              role: 'user',
              content: formatTaskContextReminder(tasks),
            },
          });
        }
        return contributions;
      },
      compactContext: (view, options) => this.bindings.contextCompactor.compact({
        sessionId,
        turnId: turn.id,
        executionProfile: request.executionProfile,
        narrativePolicy: request.narrativePolicy,
        messages: [...view.historyMessages],
        prefixMessages: view.prefixMessages,
        suffixMessages: view.suffixMessages,
        requiredRestoreMessages: view.requiredRestoreMessages,
        tools: view.tools,
        force: options?.force,
        modelContextWindow: contextWindow,
        modelMaxOutputTokens,
        providerId,
        model,
        emit: this.bindings.systemBus
          ? (event) => this.bindings.systemBus.emit(event)
          : undefined,
      }).then((result) => result.messages),
    };
  }

  private engineStreamFor(
    request:   TurnRequest,
    turn:      Turn,
    signal:    AbortSignal,
    sessionId: ReturnType<typeof asSessionId>,
    requestDegradations: RequestDegradationNotice[],
  ): AsyncIterable<EmaStreamEvent> {
    switch (request.executionProfile) {
      case 'chat': {
        const sess = this.bindings.session.getSession(sessionId);
        const { providerId, model } = this.resolveLlmForTurn(request);
        const contextWindow = providerId && model
          ? this.bindings.providerLlmModels.contextWindowFor(providerId, model)
            ?? this.bindings.modelCapabilities.resolve({ providerId, model }).contextWindow
            ?? 200_000
          : 200_000;
        const modelMaxOutputTokens = providerId && model
          ? this.bindings.modelCapabilities.resolve({ providerId, model }).maxOutput
          : undefined;
        return this.conversation.run({
          turn, signal, sessionId,
          userInput:    request.userInput,
          prompt:       buildPromptSnapshot({
            activeCharacter: this.bindings.card.current(),
            executionProfile: request.executionProfile,
            narrativePolicy: request.narrativePolicy,
          }),
          workspaceRoot: sess.workspaceRoot,
          contentParts: request.contentParts,
          persistedUserInput: request.persistedUserInput,
          providerId,
          model,
          thinking:     request.thinking,
          requestDegradations,
          prepareContextContributions: async (contextRequest) => {
            const recalled = await this.bindings.memory.prepareRecallContribution({
              sessionId: contextRequest.sessionId,
              turnId: contextRequest.turnId,
              executionProfile: contextRequest.executionProfile,
              narrativePolicy: contextRequest.narrativePolicy,
              userInput: contextRequest.userInput,
              signal: contextRequest.signal,
            });
            return recalled.contribution ? [recalled.contribution] : [];
          },
          compactContext: providerId && model ? (view) => this.bindings.contextCompactor.compact({
            sessionId:          turn.sessionId,
            turnId:             turn.id,
            executionProfile:   request.executionProfile,
            narrativePolicy:    request.narrativePolicy,
            messages:           [...view.historyMessages],
            prefixMessages:     view.prefixMessages,
            suffixMessages:     view.suffixMessages,
            requiredRestoreMessages: view.requiredRestoreMessages,
            tools:              view.tools,
            modelContextWindow: contextWindow,
            modelMaxOutputTokens,
            providerId,
            model,
            emit:               this.bindings.systemBus
              ? (ev) => this.bindings.systemBus.emit(ev)
              : undefined,
          }).then(r => r.messages) : undefined,
        });
      }

      case 'work': {
        throw new Error('Work profile must start through TurnExecutor.start()');
      }
    }
  }

  /**
   * Core 在 Engine 接管前报告 Turn 失败。Session 状态必须先落盘，随后才允许
   * Observer 读取终态；返回的诊断事件由仍然存在的 SSE 流负责转发。
   */
  private async reportTurnFailure(
    turn: Turn,
    code: TurnFailureCode,
    message: string,
    phase: TurnFailurePhase,
  ): Promise<EmaStreamEvent[]> {
    this.bindings.session.failTurn(turn.id, code, message);
    const emitted: EmaStreamEvent[] = [];
    await this.bindings.hooks.trigger('onTurnFailure', {
      turnId: turn.id,
      sessionId: turn.sessionId,
      payload: {
        phase,
        code,
        message,
        durationMs: Date.now() - turn.startedAt,
      },
      emit: (event) => emitted.push(event),
    });
    return emitted;
  }

  /** Turn 选择必须提供完整 Provider + Model；非 Turn 业务才允许读取自己的显式 Binding。 */
  private resolveLlmForTurn(request: TurnRequest): { providerId: string; model: string } | { providerId: undefined; model: undefined } {
    if (request.providerId || request.model) {
      return request.providerId && request.model
        ? { providerId: request.providerId, model: request.model }
        : { providerId: undefined, model: undefined };
    }

    // Turn 的模型来自显式选择，不能用注册顺序或旧 Binding 猜测。
    return { providerId: undefined, model: undefined };
  }

  private async maybeBuildCoordinator(
    request:   TurnRequest,
    turnId:    TurnId,
    sessionId: ReturnType<typeof asSessionId>,
    signal:    AbortSignal,
    emit:      (ev: EmaStreamEvent) => void,
  ): Promise<TtsCoordinator | null> {
    if (!request.ttsEnabled) return null;

    // Each gate below silently produced no audio (no warning). Log every
    // skip reason so "TTS enabled but no sound" is diagnosable from the
    // sidecar console instead of guessed at.
    const bindingRow = this.bindings.modelBindings.get('tts');
    if (!bindingRow) {
      console.warn('[tts] no audio: no `tts` model binding configured');
      return null;
    }

    const card  = this.bindings.card.current();
    const voice = resolveVoice(card.id, this.bindings.card);
    if (!voice) {
      console.warn(`[tts] no audio: card "${card.id}" has no reference audio registered (voiceProfile.refAudios empty)`);
      return null;
    }

    // Ensure voiceUri (cache hit → skip upload; cache miss → upload + persist)
    const adapter = this.bindings.tts.getAdapter(bindingRow.providerConfigId);
    if (!adapter) {
      console.warn(`[tts] no audio: no TTS adapter for provider ${bindingRow.providerConfigId}`);
      return null;
    }
    const model   = bindingRow.model;
    const cache = new VoiceUriCache(new SettingsRepo(this.bindings.profileDb.sqlite));
    await ensureVoiceUri(voice, adapter, model, card.id, bindingRow.providerConfigId, cache, signal);

    // GPT-SoVITS uses refAudioPath directly and never sets voiceUri.
    // Cloud adapters (DashScope, OpenAI-TTS) require voiceUri — reject if absent.
    if (!voice.voiceUri && adapter.protocol !== 'gpt-sovits-tts') {
      console.warn(`[tts] no audio: cloud adapter ${adapter.protocol} requires a voiceUri but upload/cache produced none`);
      return null;
    }

    return new TtsCoordinator({
      turnId,
      sessionId,
      voice,
      providerId: bindingRow.providerConfigId,
      model,
      ttsClient:  this.bindings.tts,
      emit,
      archive:    this.bindings.audioArchive,
      format:     'mp3',
      signal,
    });
  }
}

// ── Signal helper ───────────────────────────────────────────────────────────

/** One-shot wake-up signal (hand-rolled Promise.withResolvers — Node 20). */
function armSignal(): { promise: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const promise = new Promise<void>((r) => { fire = r; });
  return { promise, fire };
}

export function buildPersistedUserInput(
  input: string | readonly LlmContentPart[],
  attachments: readonly Attachment[],
): MessageBlocks {
  if (typeof input === 'string' && attachments.length === 0) return input;

  const blocks: Array<LlmContentPart | AttachmentReferenceBlock> = [];
  if (typeof input === 'string') {
    if (input) blocks.push({ type: 'text', text: input });
  } else {
    for (const part of input) {
      if (part.type === 'image_data' || part.type === 'audio_data' || part.type === 'file_data') {
        blocks.push({
          type: 'text',
          text: `[本轮${mediaLabel(part.type)}正文未写入会话数据库]`,
        });
        continue;
      }
      blocks.push(part);
    }
  }

  for (const attachment of attachments) {
    blocks.push({
      type: 'attachment_ref',
      attachmentId: attachment.id,
      name: attachment.name,
      mimeType: attachment.mime,
    });
  }
  return blocks;
}

function mediaLabel(type: 'image_data' | 'audio_data' | 'file_data'): string {
  if (type === 'image_data') return '图片';
  if (type === 'audio_data') return '音频';
  return '文件';
}

// ── Merge helper ────────────────────────────────────────────────────────────
//
// Yields engine events AND coordinator-pushed events as they arrive, in
// arrival order. When the engine is done, drains any in-flight TTS events
// before returning. The coordinator's own `finish()` call (in the caller)
// is responsible for awaiting in-flight syntheses — this loop only drains
// what's already been pushed at the moment of engine completion.

async function* mergeStreams(
  engineEvents:    AsyncIterable<EmaStreamEvent>,
  coordinator:     TtsCoordinator | null,
  queue:           EmaStreamEvent[],
  waitForTtsPush:  () => Promise<void>,
): AsyncGenerator<EmaStreamEvent, void, void> {
  if (!coordinator) {
    yield* engineEvents;
    return;
  }

  const iter = engineEvents[Symbol.asyncIterator]();
  let nextEngine: Promise<IteratorResult<EmaStreamEvent>> | null = null;
  let engineDone = false;

  while (!engineDone || queue.length > 0) {
    while (queue.length > 0) yield queue.shift()!;

    if (engineDone) break;

    if (!nextEngine) nextEngine = iter.next();

    const winner = await Promise.race([
      nextEngine.then((r) => ({ kind: 'engine' as const, r })),
      waitForTtsPush().then(() => ({ kind: 'tts' as const })),
    ]);

    if (winner.kind === 'engine') {
      nextEngine = null;
      if (winner.r.done) {
        engineDone = true;
      } else {
        if (winner.r.value.type === 'output_text_delta') {
          coordinator.acceptTextDelta(winner.r.value.delta);
        }
        yield winner.r.value;
      }
    }
    // 'tts' winner just loops back and drains queue
  }
}
