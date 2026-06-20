import type { AppBindings } from '../wiring.js';
import type {
  TurnMode, EmaStreamEvent, TurnId,
} from '@ema-agent/contracts';
import type { LlmContentPart } from '@ema-agent/llm';
import type { AttachmentInput } from '@ema-agent/attachment';
import { asSessionId } from '@ema-agent/contracts';
import { ConversationEngine } from '@ema-agent/conversation';
import { AgentEngine }        from '@ema-agent/agent';
import { buildSystemPrompt }  from '@ema-agent/prompts';
import { TtsCoordinator }     from '@ema-agent/tts';
import { SettingsRepo } from '@ema-agent/storage';
import { resolveVoice, ensureVoiceUri, VoiceUriCache } from '../wiring/providers/tts.js';
import type { Turn }           from '@ema-agent/session';

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
  model?:           string;
  /**
   * Whether to spawn a TtsCoordinator for this turn. Defaults to false —
   * the frontend opts in per turn (after the user toggles the speaker icon).
   * When false, no TTS synthesis happens and no `tts_chunk` events emit.
   */
  ttsEnabled?:  boolean;
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
  onAudioFinalized?: (turnId: TurnId, audioPath: string | null) => void;
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

  async run(request: TurnRequest): Promise<TurnResult> {
    const sessionId = asSessionId(request.sessionId);
    const { turn, signal } = this.bindings.session.startTurn({
      sessionId,
      mode:      request.mode,
      userInput: request.userInput,
    });
    const turnId = turn.id;
    this.activeTurns.set(turnId as string, sessionId);

    // Persist per-turn attachments and merge them into the engine input.
    // Images → prepended to contentParts as base64 parts.
    // Other files → appended as a text block listing their paths.
    let contentParts = request.contentParts;
    let userInput    = request.userInput;
    if (request.attachmentInputs?.length) {
      const stored   = this.bindings.attachmentStore.addAll(request.attachmentInputs, turnId, sessionId);
      const resolved = this.bindings.attachmentStore.resolveForPrompt(stored);

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
      this.bindings.session.failTurn(turnId, 'turn/setup_failed', message);
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
          const { audioPath } = await coordinator.finish();
          while (ttsQueue.length > 0) yield ttsQueue.shift()!;
          callbacks.onAudioFinalized?.(turnId, audioPath);
        } else if (coordinator) {
          await coordinator.abort();
          ttsQueue.length = 0;
          callbacks.onAudioFinalized?.(turnId, null);
        }

        if (pendingTurnDone) yield pendingTurnDone;
      } catch (err) {
        if (coordinator) {
          await coordinator.abort();
          callbacks.onAudioFinalized?.(turnId, null);
        }
        throw err;
      } finally {
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
      case 'narrative':
        return this.conversation.run({
          turn, signal, sessionId,
          mode:         request.mode,
          userInput:    request.userInput,
          contentParts: request.contentParts,
          model:        request.model,
        });

      case 'agent': {
        const sess           = this.bindings.session.getSession(sessionId);
        const workspaceRoots = sess.workspaceRoots.length > 0 ? sess.workspaceRoots : [process.cwd()];
        const systemPrompt   = buildSystemPrompt(
          this.bindings.card.current(),
          'agent',
          { workspaceRoots },
        );

        // Resolve provider + model here — AgentEngine is binding-unaware.
        const binding    = this.bindings.modelBindings.get('agent');
        const providerId = binding?.providerConfigId ?? this.bindings.llm.firstProviderId();
        const model      = request.model ?? binding?.model
          ?? (providerId ? this.bindings.llm.defaultModelFor(providerId) : undefined);

        if (!providerId || !model) {
          // Persist the failure BEFORE yielding the event — a yielded
          // turn_failed without failTurn leaves the turn 'running' and the
          // RunRegistry locked (session_busy forever, engines do this too).
          this.bindings.session.failTurn(turn.id, 'provider/not_configured',
            'No LLM provider configured for agent mode');
          return (async function* () {
            yield { type: 'turn_failed' as const, sessionId, turnId: turn.id, code: 'provider/not_configured', message: 'No LLM provider configured for agent mode' };
          })();
        }

        return this.agent.run({
          turn, signal,
          providerId,
          model,
          userInput:      request.contentParts?.length ? request.contentParts : (request.userInput ?? ''),
          systemPrompt,
          workspaceRoots,
        });
      }
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
    const model   = request.model ?? bindingRow.model;
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
