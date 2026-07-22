// 接收一次 Turn 请求，选择执行方式，并把执行过程整理成前端需要的事件流。

import type {
  AppBindings } from '../wiring/index.js';
import type {
  TurnMode,
  TurnId,
  SessionId,
} from '@ema-agent/contracts';
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
import { asSessionId,
} from '@ema-agent/contracts';
import type {
  EmaStreamEvent,
  RequestDegradationNotice,
  TurnFailureCode,
} from '@ema-agent/turn';
import { ConversationEngine } from '@ema-agent/conversation';
import { AgentEngine }        from '@ema-agent/agent';
import { TtsCoordinator }     from '@ema-agent/tts';
import type { FinalizedAudio } from '@ema-agent/tts';
import { SettingsRepo } from '@ema-agent/storage';
import { resolveVoice, ensureVoiceUri, VoiceUriCache } from '../wiring/providers/tts.js';
import { ensureSessionLayout, scratchpadTurnDir } from '../storage-locations/index.js';
import type { AttachmentReferenceBlock, MessageBlocks, Turn } from '@ema-agent/session';
import type { TurnFailurePhase } from '@ema-agent/hooks';
import { prepareImagesForModel, replaceImageParts } from './media-compatibility.js';
import { buildPromptSnapshot } from '@ema-agent/prompts';

export interface TurnResult {
  turnId: TurnId;
  events: AsyncIterable<EmaStreamEvent>;
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
 * Orchestrator — picks the right engine for the requested mode and wires it.
 *
 * Per-turn it builds an event-merging generator that yields:
 *   - Events from the engine (output_text_delta, tool_call_*, permission_*…)
 *   - Events from the TtsCoordinator (tts_chunk, tts_sentence_complete,
 *     system_warning on TTS failure)
 *
 * Engine and coordinator run concurrently — engine drives the LLM stream
 * and yields output_text_delta events, the coordinator receives a copy of
 * those visible deltas, accumulates sentences, and synthesizes them. Audio
 * events are pushed into a shared queue that the merged generator drains
 * alongside engine events.
 */
export class Orchestrator {
  private readonly conversation: ConversationEngine;
  private readonly agent:        AgentEngine;
  private readonly callbacks:    OrchestratorCallbacks;
  // turnId → sessionId, kept alive until the events generator exits
  private readonly activeTurns = new Map<string, ReturnType<typeof asSessionId>>();

  constructor(
    private readonly bindings:   AppBindings,
    callbacks:                   OrchestratorCallbacks = {},
  ) {
    this.callbacks    = callbacks;
    this.conversation = new ConversationEngine(bindings);
    this.agent = new AgentEngine({
      session:           bindings.session,
      turnLifecycle:     bindings.agentTurnLifecycle,
      hooks:             bindings.hooks,
      llm:               bindings.llm,
      modelCapabilities: bindings.modelCapabilities,
      emotion:           bindings.emotion,
      tools:             bindings.tools,
      permission:        bindings.permission,
      getCommandRunner:  bindings.getCommandRunner,
      buildAsk:          bindings.buildAskForTurn,
      askUserRegistry:   bindings.askUserRegistry,
      artifactStore:     bindings.artifactStore,
      mcpClient:         bindings.mcpBridge,
      skillRunner:       bindings.skillBridge,
      kbSearch:          bindings.kbSearch,
      getContextStores:  bindings.getContextStores,
      taskStore:         bindings.taskStore,
      toolExecutionJournal: bindings.toolExecutionJournal,
    });
  }

  /** Signal abort for a running turn. No-op if turn is not active. */
  abort(turnId: TurnId): void {
    const sessionId = this.activeTurns.get(turnId as string);
    if (!sessionId) return;
    this.bindings.session.requestAbort(sessionId);
  }

  /** Cancel a single sub-agent without aborting the parent turn. No-op if not found. */
  abortSubagent(turnId: TurnId, subagentId: string): void {
    this.agent.abortSubagent(turnId as string, subagentId);
  }

  /** Cancel a single in-flight tool without aborting the parent turn. Returns false if not found. */
  abortTool(turnId: TurnId, callId: string): boolean {
    return this.agent.abortTool(turnId as string, callId);
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    const sessionId = asSessionId(request.sessionId);
    const legacyMode = this.legacyModeFor(request);
    // Ensure the per-session directory tree exists before any audio/artifact
    // writes land in it. Cheap (mkdirSync recursive) and idempotent.
    ensureSessionLayout(this.bindings.activeDataDir, sessionId as string);
    const startInput = {
      sessionId,
      triggerType: request.trigger.type,
      executionProfile: request.executionProfile,
      narrativePolicy: request.narrativePolicy,
      userInput: request.userInput,
    };
    const { turn, signal } = request.executionProfile === 'work'
      ? this.bindings.agentTurnLifecycle.start(startInput)
      : this.bindings.session.startTurn(startInput);
    const turnId = turn.id;
    this.activeTurns.set(turnId as string, sessionId);

    // 持久化本轮附件并合并到 Engine 输入中。
    // 图片以 base64 内容块加入；当前 LLM 不支持图片时，先转换成明确的文字描述。
    // 其他文件由附件存储层整理为路径提示文本。
    let contentParts = request.contentParts;
    let userInput    = request.userInput;
    let storedAttachments: Attachment[] = [];
    const requestDegradations: RequestDegradationNotice[] = [];
    // 附件准备包含数据库写入与 Vision 调用。此时 Turn 已注册，任何异常都必须
    // 释放运行锁，否则 Session 会一直停留在 session_busy，直至进程重启。
    try {
      if (request.attachmentInputs?.length) {
        storedAttachments = this.bindings.attachmentStore.addAll(request.attachmentInputs, turnId, sessionId);
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
          userInput    = '';
        }
      }

      // attachmentInputs 与直接 contentParts 统一走同一能力门禁，避免调用方
      // 绕过附件存储路径后把图片直接塞给纯文本模型。
      const imageParts = contentParts?.filter(
        (part) => part.type === 'image_data' || part.type === 'image_url',
      ) ?? [];
      if (imageParts.length > 0) {
        const resolvedLlm = this.resolveLlmForTurn(request);
        if (!resolvedLlm.providerId || !resolvedLlm.model) {
          throw new Error('provider/not_configured');
        }
        const fallback = await prepareImagesForModel({
          capabilitiesFor: (providerId, model) => this.bindings.modelCapabilities.resolve({ providerId, model }),
          visionBinding: () => this.bindings.modelBindings.get('vision'),
          describeImages: async ({ providerId, model, inputs, signal: visionSignal }) => {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const providerCode = llmProviderErrorCode(err);
        await this.reportTurnFailure(
          turn,
          providerCode === 'provider/model_capability_unsupported'
            ? providerCode
            : 'turn/attachment_failed',
          message,
          'setup',
        );
      } catch { /* fall through to clear */ }
      this.bindings.session.clearRunning(sessionId);
      this.activeTurns.delete(turnId as string);
      throw err;
    }

    // Build the TTS queue + coordinator before the engine stream is consumed.
    // Queue is shared between coordinator.emit and the merge loop.
    //
    // Wake-up uses a standing signal, not a one-shot slot: push fires the
    // CURRENT signal at push time (double-fire is harmless), the consumer
    // re-arms a fresh one each time it waits. The old slot pattern had a
    // window where a push landed while no waiter was armed — the event sat
    // in the queue until the next engine event, which during a long tool
    // execution could be a minute away (audio stalls).
    const ttsQueue: EmaStreamEvent[] = [];
    let ttsSignal = armSignal();
    const pushTts = (ev: EmaStreamEvent): void => {
      ttsQueue.push(ev);
      ttsSignal.fire();
    };

    // TTS is an enhancement — its setup does real I/O (ensureVoiceUri uploads
    // reference audio) and MUST NOT kill the turn. A failure here used to
    // propagate out of run() with the turn already started: nobody called
    // failTurn, the in-memory RunRegistry never cleared, and the session was
    // stuck on session_busy until process restart. Degrade to silent instead.
    let coordinator: TtsCoordinator | null = null;
    try {
      coordinator = await this.maybeBuildCoordinator(request, turnId, sessionId, signal, pushTts);
    } catch (err) {
      pushTts({
        type:    'system_warning',
        level:   'warn',
        message: `TTS 初始化失败，本轮无语音：${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Any synchronous failure while preparing the engine stream must release
    // the turn — same stuck-turn class as the coordinator path above.
    let engineEvents: AsyncIterable<EmaStreamEvent>;
    try {
      const resolvedRequest = contentParts !== request.contentParts || userInput !== request.userInput
        ? { ...request, contentParts, userInput }
        : request;
      const persistedUserInput = buildPersistedUserInput(
        contentParts?.length ? contentParts : userInput,
        storedAttachments,
      );
      engineEvents = this.engineStreamFor(
        { ...resolvedRequest, persistedUserInput },
        legacyMode,
        turn,
        signal,
        sessionId,
        requestDegradations,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // failTurn may itself throw (requireTurn / DB write) — guard it so the
      // unconditional clearRunning below still runs and the lock is released.
      try {
        await this.reportTurnFailure(turn, 'turn/setup_failed', message, 'setup');
      } catch { /* fall through to clear */ }
      this.bindings.session.clearRunning(sessionId);
      this.activeTurns.delete(turnId as string);
      throw err;
    }

    const { callbacks } = this;
    const self = this;
    const events = (async function* () {
      try {
        // Drain anything pushed before the merge loop starts (e.g. the TTS
        // degrade warning above — with coordinator null, mergeStreams never
        // touches ttsQueue).
        while (ttsQueue.length > 0) yield ttsQueue.shift()!;

        let pendingTurnDone: EmaStreamEvent | null = null;

        for await (const ev of mergeStreams(engineEvents, coordinator, ttsQueue, () => {
          // Re-arm then hand out: pushes from this moment on fire the new
          // signal; anything pushed earlier is already in ttsQueue and gets
          // picked up by the merge loop's drain pass.
          ttsSignal = armSignal();
          return ttsSignal.promise;
        })) {
          // Terminal turn events must be yielded LAST. For completed turns we
          // drain/finalize TTS first; for failed/aborted turns we cancel TTS and
          // discard any archive segments before surfacing the terminal event.
          if (
            ev.type === 'turn_completed' ||
            ev.type === 'turn_failed'  ||
            ev.type === 'turn_aborted'
          ) {
            pendingTurnDone = ev;
            continue;
          }
          yield ev;
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
      } catch (err) {
        if (coordinator) {
          await coordinator.abort();
          callbacks.onAudioFinalized?.(turnId, sessionId, null);
        }
        throw err;
      } finally {
        // Unconditional: release the in-memory turn lock even if the engine
        // threw before reaching completeTurn/failTurn/abortTurn, or if those
        // terminal methods threw before their own registry.clear() ran.
        // Idempotent — safe alongside the clear inside the terminal methods.
        self.bindings.session.clearRunning(sessionId);
        self.activeTurns.delete(turnId as string);
      }
    })();

    return { turnId, events };
  }

  private engineStreamFor(
    request:   TurnRequest,
    legacyMode: TurnMode,
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
          mode:         legacyMode as Exclude<TurnMode, 'agent'>,
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
            const recalled = await this.bindings.memory.prepareRecallContribution(contextRequest);
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
        const sess          = this.bindings.session.getSession(sessionId);
        const workspaceRoot = sess.workspaceRoot ?? process.cwd();

        const { providerId, model } = this.resolveLlmForTurn(request);
        if (!providerId || !model) {
          const self = this;
          const message = 'No LLM provider configured for work profile';
          return (async function* () {
            const diagnostics = await self.reportTurnFailure(
              turn,
              'provider/not_configured',
              message,
              'provider',
            );
            for (const event of diagnostics) yield event;
            yield { type: 'turn_failed' as const, sessionId, turnId: turn.id, code: 'provider/not_configured' as const, message };
          })();
        }

        const contextWindow = this.bindings.providerLlmModels.contextWindowFor(providerId, model)
          ?? this.bindings.modelCapabilities.resolve({ providerId, model }).contextWindow
          ?? 200_000;
        const modelMaxOutputTokens = this.bindings.modelCapabilities.resolve({ providerId, model }).maxOutput;

        return this.agent.run({
          turn, signal,
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
          userInput:      request.contentParts?.length ? request.contentParts : (request.userInput ?? ''),
          persistedUserInput: request.persistedUserInput,
          workspaceRoot,
          scratchpadDir: scratchpadTurnDir(
            this.bindings.activeDataDir,
            sessionId,
            turn.id as string,
          ),
          kbIds:          request.kbIds,
          kbAssetScopes:  request.kbAssetScopes,
          thinking:       request.thinking,
          requestDegradations,
          prepareContextContributions: async (contextRequest) => {
            const recalled = await this.bindings.memory.prepareRecallContribution(contextRequest);
            return recalled.contribution ? [recalled.contribution] : [];
          },
          compactContext: (view, options) => this.bindings.contextCompactor.compact({
            sessionId:          turn.sessionId,
            turnId:             turn.id,
            executionProfile:   request.executionProfile,
            narrativePolicy:    request.narrativePolicy,
            messages:           [...view.historyMessages],
            prefixMessages:     view.prefixMessages,
            suffixMessages:     view.suffixMessages,
            tools:              view.tools,
            force:              options?.force,
            modelContextWindow: contextWindow,
            modelMaxOutputTokens,
            providerId,
            model,
            recentFiles:        this.bindings.getContextStores(turn.sessionId)
              .fileStateStore.recentEntries(20),
            emit:               this.bindings.systemBus
              ? (ev) => this.bindings.systemBus.emit(ev)
              : undefined,
          }).then(r => r.messages),
        });
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
    if (turn.mode === 'agent') {
      this.bindings.agentTurnLifecycle.fail({ turnId: turn.id, code, message });
    } else {
      this.bindings.session.failTurn(turn.id, code, message);
    }
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

  /** 旧 Engine/SQL 尚未退役前的唯一语义映射；TurnLoop 接线完成后删除。 */
  private legacyModeFor(request: TurnRequest): TurnMode {
    if (request.executionProfile === 'work') return 'agent';
    return request.narrativePolicy === 'always' ? 'narrative' : 'chat';
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
