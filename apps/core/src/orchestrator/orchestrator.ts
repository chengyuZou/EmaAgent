import type { AppBindings } from '../wiring/index.js';
import type {
  TurnMode, EmaStreamEvent, TurnId, SessionId, KbAssetScope,
} from '@ema-agent/contracts';
import { getProviderDefinition } from '@ema-agent/contracts';
import type { ThinkingMode } from '@ema-agent/llm';
import type { LlmContentPart } from '@ema-agent/llm';
import type { AttachmentInput } from '@ema-agent/attachment';
import { asSessionId } from '@ema-agent/contracts';
import { ConversationEngine } from '@ema-agent/conversation';
import { AgentEngine }        from '@ema-agent/agent';
import { buildSystemPrompt }  from '@ema-agent/prompts';
import { TtsCoordinator }     from '@ema-agent/tts';
import type { FinalizedAudio } from '@ema-agent/tts';
import { SettingsRepo } from '@ema-agent/storage';
import type { BindingModule } from '@ema-agent/storage';
import { resolveVoice, ensureVoiceUri, VoiceUriCache } from '../wiring/providers/tts.js';
import { ensureSessionLayout } from '../storage-locations/index.js';
import type { Turn }           from '@ema-agent/session';
import type { VisionImageInput, VisionImageMime } from '@ema-agent/vision';

export interface TurnResult {
  turnId: TurnId;
  events: AsyncIterable<EmaStreamEvent>;
}

export interface TurnRequest {
  sessionId:        string;
  mode:             TurnMode;
  userInput:        string;
  contentParts?:    LlmContentPart[];
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
      hooks:             bindings.hooks,
      llm:               bindings.llm,
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
      dataDir:           bindings.activeDataDir,
    });
  }

  /** Signal abort for a running turn. No-op if turn is not active. */
  abort(turnId: TurnId): void {
    const sessionId = this.activeTurns.get(turnId as string);
    if (!sessionId) return;
    this.bindings.session.abortTurn(sessionId, turnId);
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
    // Ensure the per-session directory tree exists before any audio/artifact
    // writes land in it. Cheap (mkdirSync recursive) and idempotent.
    ensureSessionLayout(this.bindings.activeDataDir, sessionId as string);
    const { turn, signal } = this.bindings.session.startTurn({
      sessionId,
      mode:      request.mode,
      userInput: request.userInput,
    });
    const turnId = turn.id;
    this.activeTurns.set(turnId as string, sessionId);

    // Persist per-turn attachments and merge them into the engine input.
    // Images → prepended to contentParts as base64 parts (or described as text
    //   if the active LLM does not support image input per the models.dev catalog).
    // Other files → appended as a text block listing their paths.
    let contentParts = request.contentParts;
    let userInput    = request.userInput;
    // Attachment setup does DB writes + a vision LLM call and can throw. The
    // turn is already registered at this point, so any throw must release the
    // lock — otherwise the session is stuck on session_busy until restart.
    try {
      if (request.attachmentInputs?.length) {
        const stored   = this.bindings.attachmentStore.addAll(request.attachmentInputs, turnId, sessionId);
        const resolved = this.bindings.attachmentStore.resolveForPrompt(stored);

        // Resolve provider + model early for vision fallback — reuse the same
        // resolution logic as engineStreamFor so providerId is consistent.
        const resolvedLlm = this.resolveLlmForTurn(request);
        const imageParts = resolved.imageParts.length > 0 && resolvedLlm.providerId
          ? await this.visionFallbackIfNeeded(resolvedLlm.providerId, resolvedLlm.model, resolved.imageParts, signal)
          : resolved.imageParts;

        if (imageParts.length > 0 || resolved.promptLines) {
          const parts: LlmContentPart[] = [...imageParts];
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try { this.bindings.session.failTurn(turnId, 'turn/attachment_failed', message); } catch { /* fall through to clear */ }
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
      engineEvents = this.engineStreamFor(resolvedRequest, turn, signal, sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // failTurn may itself throw (requireTurn / DB write) — guard it so the
      // unconditional clearRunning below still runs and the lock is released.
      try { this.bindings.session.failTurn(turnId, 'turn/setup_failed', message); } catch { /* fall through to clear */ }
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
    turn:      Turn,
    signal:    AbortSignal,
    sessionId: ReturnType<typeof asSessionId>,
  ): AsyncIterable<EmaStreamEvent> {
    switch (request.mode) {
      case 'chat':
      case 'narrative': {
        const { providerId, model } = this.resolveLlmForTurn(request);
        return this.conversation.run({
          turn, signal, sessionId,
          mode:         request.mode,
          userInput:    request.userInput,
          contentParts: request.contentParts,
          providerId,
          model,
          thinking:     request.thinking,
        });
      }

      case 'agent': {
        const sess          = this.bindings.session.getSession(sessionId);
        const workspaceRoot = sess.workspaceRoot ?? process.cwd();
        const systemPrompt  = buildSystemPrompt(
          this.bindings.card.current(),
          'agent',
          { workspaceRoot },
        );

        const { providerId, model } = this.resolveLlmForTurn(request);
        if (!providerId || !model) {
          this.bindings.session.failTurn(turn.id, 'provider/not_configured',
            'No LLM provider configured for agent mode');
          return (async function* () {
            yield { type: 'turn_failed' as const, sessionId, turnId: turn.id, code: 'provider/not_configured', message: 'No LLM provider configured for agent mode' };
          })();
        }

        const contextWindow = this.bindings.providerLlmModels.contextWindowFor(providerId, model)
          ?? this.bindings.modelCatalog.contextWindowOf(model)
          ?? 200_000;

        return this.agent.run({
          turn, signal,
          providerId,
          model,
          userInput:      request.contentParts?.length ? request.contentParts : (request.userInput ?? ''),
          systemPrompt,
          workspaceRoot,
          kbIds:          request.kbIds,
          kbAssetScopes:  request.kbAssetScopes,
          thinking:       request.thinking,
          compactMessages: (msgs) => this.bindings.memory.compact({
            sessionId:          turn.sessionId,
            turnId:             turn.id,
            mode:               'agent',
            messages:           msgs,
            modelContextWindow: contextWindow,
            providerId,
            model,
            emit:               this.bindings.systemBus
              ? (ev) => this.bindings.systemBus.emit(ev)
              : undefined,
          }).then(r => r.messages),
        });
      }
    }
  }

  /**
   * Resolve (providerId, model) for a turn. Prefers request.providerId/model
   * (frontend model picker), falls back to the per-mode binding (legacy),
   * then to the first available LLM provider.
   */
  private resolveLlmForTurn(request: TurnRequest): { providerId: string; model: string } | { providerId: undefined; model: undefined } {
    // Path 1: explicit (providerId, model) from frontend picker
    if (request.providerId && request.model) {
      return { providerId: request.providerId, model: request.model };
    }
    // Path 2: model only — resolve provider from request.providerId.
    // chat/narrative/agent no longer use model_bindings (model comes from
    // the frontend picker). Other modes still read their binding.
    const isTurnMode = request.mode === 'chat' || request.mode === 'narrative' || request.mode === 'agent';
    const binding    = isTurnMode ? undefined : this.bindings.modelBindings.get(request.mode as BindingModule);
    const providerId = request.providerId ?? binding?.providerConfigId ?? this.bindings.llm.firstProviderId();
    const model      = request.model ?? binding?.model
      ?? (providerId ? this.bindings.llm.defaultModelFor(providerId) : undefined);
    if (!providerId || !model) return { providerId: undefined, model: undefined };
    return { providerId, model };
  }

  /**
   * If the active LLM does not accept image input (per the models.dev catalog),
   * describe the images via VisionRouter and return a single text part instead.
   * Falls back to the original parts on any error or when no vision provider is
   * configured — never throws.
   */
  private async visionFallbackIfNeeded(
    providerId: string,
    model:      string,
    imageParts: LlmContentPart[],
    signal:     AbortSignal,
  ): Promise<LlmContentPart[]> {
    const modelRow    = this.bindings.providerLlmModels.get(providerId, model);
    const modelsDevId = modelRow?.definition_id ? getProviderDefinition(modelRow.definition_id)?.modelsDevId : undefined;
    // Unknown provider (custom OpenAI-compat, etc.) → assume it handles images.
    if (!modelsDevId) return imageParts;

    if (this.bindings.modelCatalog.supportsImageInput(modelsDevId, model)) {
      return imageParts;
    }

    // LLM does not support image input — describe via VisionRouter.
    const visionBinding = this.bindings.modelBindings.get('vision');
    if (!visionBinding) return imageParts;

    const base64Inputs: VisionImageInput[] = imageParts
      .filter((p): p is Extract<LlmContentPart, { type: 'image_data' }> => p.type === 'image_data')
      .map((p) => ({
        kind:     'base64' as const,
        data:     p.data,
        mimeType: p.mimeType as VisionImageMime,
      }));

    if (base64Inputs.length === 0) return imageParts; // image_url only → pass through

    try {
      const result = await this.bindings.vision.extract({
        providerId: visionBinding.providerConfigId,
        model:      visionBinding.model,
        task:       'caption',
        inputs:     base64Inputs,
        signal,
      });
      return [{ type: 'text', text: `[图片内容]\n${result.text}` }];
    } catch {
      return imageParts;
    }
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
    await ensureVoiceUri(voice, adapter, model, card.id, bindingRow.providerConfigId, cache);

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
