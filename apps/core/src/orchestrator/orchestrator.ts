import type { AppBindings } from '../wiring.js';
import type {
  TurnMode, AgentSubMode, EmaStreamEvent, TurnId,
} from '@ema-agent/contracts';
import type { LlmContentPart } from '@ema-agent/llm';
import { asSessionId } from '@ema-agent/contracts';
import { ConversationEngine } from '@ema-agent/conversation';
import { AgentEngine }        from '@ema-agent/agent';
import { buildSystemPrompt }  from '@ema-agent/prompts';
import { TtsCoordinator }     from '@ema-agent/tts';
import { SettingsRepo } from '@ema-agent/storage';
import { resolveVoice, ensureVoiceUri, VoiceUriCache } from '../wiring/tts.js';
import type { Turn }           from '@ema-agent/session';

export interface TurnResult {
  turnId: TurnId;
  events: AsyncIterable<EmaStreamEvent>;
}

export interface TurnRequest {
  sessionId:    string;
  mode:         TurnMode;
  subMode?:     AgentSubMode;
  userInput:    string;
  contentParts?: LlmContentPart[];
  model?:       string;
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
 * and triggers afterLlmDelta hooks, the coordinator (subscribed to those
 * hooks) accumulates sentences and synthesizes them, pushing audio events
 * into a shared queue that the merged generator drains alongside engine
 * events.
 */
export class Orchestrator {
  private readonly conversation: ConversationEngine;
  private readonly agent:        AgentEngine;
  private readonly callbacks:    OrchestratorCallbacks;

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
      getContextStores:  bindings.getContextStores,
    });
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    const sessionId = asSessionId(request.sessionId);
    const { turn, signal } = this.bindings.session.startTurn({
      sessionId,
      mode:         request.mode,
      agentSubMode: request.subMode,
      userInput:    request.userInput,
    });
    const turnId = turn.id;

    // Build the TTS queue + coordinator BEFORE the engine starts so the
    // coordinator's afterLlmDelta hook is registered when the first delta
    // fires. Queue is shared between coordinator.emit and the merge loop.
    const ttsQueue: EmaStreamEvent[] = [];
    let notifyTts: (() => void) | null = null;
    const pushTts = (ev: EmaStreamEvent): void => {
      ttsQueue.push(ev);
      notifyTts?.();
      notifyTts = null;
    };

    const coordinator = await this.maybeBuildCoordinator(request, turnId, sessionId, pushTts);
    coordinator?.start();

    const engineEvents = this.engineStreamFor(request, turn, signal, sessionId);

    const self = this;
    const events = (async function* () {
      try {
        let pendingTurnDone: EmaStreamEvent | null = null;

        for await (const ev of mergeStreams(engineEvents, coordinator, ttsQueue, () => {
          const w = new Promise<void>((r) => { notifyTts = r; });
          return w;
        })) {
          // turn_completed / turn_failed / turn_aborted must be yielded LAST
          // so that the SSE store doesn't mark the turn done before TTS audio
          // chunks are drained. Hold them until finish() completes.
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

        if (coordinator) {
          const { audioPath } = await coordinator.finish();
          while (ttsQueue.length > 0) yield ttsQueue.shift()!;
          self.callbacks.onAudioFinalized?.(turnId, audioPath);
        }

        if (pendingTurnDone) yield pendingTurnDone;
      } catch (err) {
        if (coordinator) {
          await coordinator.abort();
          self.callbacks.onAudioFinalized?.(turnId, null);
        }
        throw err;
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
        const subMode = request.subMode ?? 'full';
        const sess    = this.bindings.session.getSession(sessionId);
        const workspaceRoot = sess.workspaceRoots[0] ?? process.cwd();
        const systemPrompt  = buildSystemPrompt(
          this.bindings.card.current(),
          'agent',
          { agentSubMode: subMode, workspaceRoots: sess.workspaceRoots },
        );

        // Resolve provider + model here — AgentEngine is binding-unaware.
        const binding    = this.bindings.modelBindings.get('agent');
        const providerId = binding?.providerConfigId ?? this.bindings.llm.firstProviderId();
        const model      = request.model ?? binding?.model
          ?? (providerId ? this.bindings.llm.defaultModelFor(providerId) : undefined);

        if (!providerId || !model) {
          return (async function* () {
            yield { type: 'turn_failed' as const, turnId: turn.id, code: 'provider/not_configured', message: 'No LLM provider configured for agent mode' };
          })();
        }

        return this.agent.run({
          turn, signal,
          subMode,
          providerId,
          model,
          // Merge contentParts + userInput into the unified field.
          userInput:             request.contentParts?.length ? request.contentParts : (request.userInput ?? ''),
          systemPrompt,
          workspaceRoot,
          additionalWorkingDirs: sess.workspaceRoots.slice(1),
        });
      }
    }
  }

  private async maybeBuildCoordinator(
    request:   TurnRequest,
    turnId:    TurnId,
    sessionId: ReturnType<typeof asSessionId>,
    emit:      (ev: EmaStreamEvent) => void,
  ): Promise<TtsCoordinator | null> {
    if (!request.ttsEnabled) return null;

    const bindingRow = this.bindings.modelBindings.get('tts');
    if (!bindingRow) return null;

    const card  = this.bindings.card.current();
    const voice = resolveVoice(card.id, this.bindings.card);
    if (!voice) return null;

    // Ensure voiceUri (cache hit → skip upload; cache miss → upload + persist)
    const adapter = this.bindings.tts.getAdapter(bindingRow.providerConfigId);
    const model   = request.model ?? bindingRow.model;
    if (adapter) {
      const cache = new VoiceUriCache(
        new SettingsRepo(this.bindings.profileDb.sqlite),
      );
      await ensureVoiceUri(voice, adapter, model, card.id, bindingRow.providerConfigId, cache);
    }

    // GPT-SoVITS uses refAudioPath directly and never sets voiceUri.
    // Cloud adapters (DashScope, OpenAI-TTS) require voiceUri — reject if absent.
    if (!voice.voiceUri && adapter?.protocol !== 'gpt-sovits-tts') return null;

    return new TtsCoordinator({
      turnId,
      sessionId,
      voice,
      providerId: bindingRow.providerConfigId,
      model,
      ttsClient:  this.bindings.tts,
      hooks:      this.bindings.hooks,
      emit,
      archive:    this.bindings.audioArchive,
      format:     'mp3',
    });
  }
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
        yield winner.r.value;
      }
    }
    // 'tts' winner just loops back and drains queue
  }
}
