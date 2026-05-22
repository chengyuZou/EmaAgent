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
import { ttsBindingModuleFor } from '@ema-agent/storage';
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
      session:          bindings.session,
      hooks:            bindings.hooks,
      llm:              bindings.llm,
      emotion:          bindings.emotion,
      tools:            bindings.tools,
      permission:       bindings.permission,
      modelBindings:    bindings.modelBindings,
      getCommandRunner: bindings.getCommandRunner,
      buildAsk:         bindings.buildAskForTurn,
    });
  }

  run(request: TurnRequest): TurnResult {
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

    const coordinator = this.maybeBuildCoordinator(request, turnId, sessionId, pushTts);
    coordinator?.start();

    const engineEvents = this.engineStreamFor(request, turn, signal, sessionId);

    const self = this;
    const events = (async function* () {
      try {
        yield* mergeStreams(engineEvents, coordinator, ttsQueue, () => {
          const w = new Promise<void>((r) => { notifyTts = r; });
          return w;
        });

        if (coordinator) {
          const { audioPath } = await coordinator.finish();
          self.callbacks.onAudioFinalized?.(turnId, audioPath);
        }
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
        const session = this.bindings.session.getSession(sessionId);
        const workspaceRoot = session.workspaceRoots[0] ?? process.cwd();
        const systemPrompt  = buildSystemPrompt(
          this.bindings.card.current(),
          'agent',
          { agentSubMode: subMode, workspaceRoots: session.workspaceRoots },
        );

        return this.agent.run({
          turn, signal, sessionId,
          subMode,
          userInput:             request.userInput,
          contentParts:          request.contentParts,
          systemPrompt,
          workspaceRoot,
          additionalWorkingDirs: session.workspaceRoots.slice(1),
          model:                 request.model,
        });
      }
    }
  }

  private maybeBuildCoordinator(
    request:   TurnRequest,
    turnId:    TurnId,
    sessionId: ReturnType<typeof asSessionId>,
    emit:      (ev: EmaStreamEvent) => void,
  ): TtsCoordinator | null {
    if (!request.ttsEnabled) return null;

    // Resolve TTS binding from model_bindings. Caller (route handler) may have
    // passed an explicit model; otherwise we read the bound provider+model.
    const bindingRow = this.bindings.modelBindings.get(
      ttsBindingModuleFor(request.mode),
    );
    if (!bindingRow) return null;

    const card = this.bindings.card.current();
    return new TtsCoordinator({
      turnId,
      sessionId,
      characterId: card.id,
      providerId:  bindingRow.providerConfigId,
      model:       request.model ?? bindingRow.model,
      turnMode:    request.mode,
      ttsClient:   this.bindings.tts,
      hooks:       this.bindings.hooks,
      emit,
      archive:     this.bindings.audioArchive,
      format:      'mp3',
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
