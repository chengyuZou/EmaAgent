import type { CharacterVoiceProfile, CharacterCardId } from '@ema-agent/contracts';
import type {
  TtsRequest,
  TtsStreamEvent,
  TtsVoiceRef,
  TtsAdapter,
  TtsProviderConfig,
} from './types.js';
import { protocolSupportsVoiceKind } from './types.js';

import { OpenAiTtsAdapter }   from './adapters/openai-tts.js';
import { GptSoVitsTtsAdapter } from './adapters/gpt-sovits-tts.js';
import { DashscopeTtsAdapter } from './adapters/dashscope-tts.js';

import { filterTextForTts } from './streaming/text-filter.js';
import { SentenceSplitter } from './streaming/sentence-splitter.js';

// ── Card lookup (Façade so we don't import character-card directly) ─────────

export interface VoiceProfileLookup {
  /** Returns null if card not found. Implementations live in apps/core/wiring. */
  getVoiceProfile(cardId: CharacterCardId): CharacterVoiceProfile | null;
}

// ── Path resolver (Façade so service doesn't import storage-locations) ─────

export interface VoiceRefPathResolver {
  /** Resolve a stored refAudioPath (relative `<cardId>/<filename>`) to absolute. */
  resolve(relPath: string): string;
}

// ── TtsClient construction ──────────────────────────────────────────────────

export interface TtsClientArgs {
  /** All registered TTS provider configs (id → creds). */
  providers: ReadonlyMap<string, TtsProviderConfig>;
  /**
   * Optional fallback. When the primary attempt fails AND no audio has been
   * emitted yet, the service retries with this fallback providerId+model.
   * Resolved by the wiring layer from settings or a special model_bindings row.
   */
  fallback?: {
    providerId: string;
    model:      string;
    voiceId:    string | null;
    config?:    Record<string, unknown>;
  };
  voiceProfiles:    VoiceProfileLookup;
  refPathResolver:  VoiceRefPathResolver;
  /** For tests: pre-built adapters keyed by providerConfigId. */
  adapterOverrides?: ReadonlyMap<string, TtsAdapter>;
}

// ── TtsClient ───────────────────────────────────────────────────────────────

/**
 * Single Façade for all TTS access. Pattern aligned with LlmRouter:
 *   - adapters: Map<providerId, TtsAdapter>     (id → instance)
 *   - configs:  Map<providerId, TtsProviderConfig> (id → config)
 *
 * synthesize(request) uses request.providerId to look up the adapter —
 * NO binding lookup inside the client. Callers resolve providerId + model
 * from model_bindings before calling.
 *
 * V1 failover model (memory:project-tts-scope):
 *   primary refAudio fails  → system fallback voice (catalog, different provider)
 *   fallback also fails     → emit error, stream ends without audio
 */
export class TtsClient {
  /** providerId → adapter instance (hot-reloadable) */
  private adapters = new Map<string, TtsAdapter>();
  /** providerId → config (kept for capability checks) */
  private configs  = new Map<string, TtsProviderConfig>();

  // Read-only across reloads
  private readonly voiceProfiles:    VoiceProfileLookup;
  private readonly refPathResolver:  VoiceRefPathResolver;
  private fallback:                  TtsClientArgs['fallback'];

  constructor(args: TtsClientArgs) {
    this.voiceProfiles   = args.voiceProfiles;
    this.refPathResolver = args.refPathResolver;
    this.fallback        = args.fallback;
    for (const [id, cfg] of args.providers) {
      this.configs.set(id, cfg);
      const override = args.adapterOverrides?.get(id);
      this.adapters.set(id, override ?? this.createAdapter(cfg));
    }
  }

  // ── Hot-reload ─────────────────────────────────────────────────────────────

  /**
   * Replace provider configs at runtime. Called from routes after
   * PUT /api/providers or PUT /api/model-bindings/:module (tts_* rows).
   * Long-lived references (TtsCoordinator) keep working — they see
   * the new state on the next synthesize() call.
   */
  reload(args: {
    providers: ReadonlyMap<string, TtsProviderConfig>;
    fallback?: TtsClientArgs['fallback'];
  }): void {
    this.adapters = new Map<string, TtsAdapter>();
    this.configs  = new Map<string, TtsProviderConfig>();
    this.fallback = args.fallback;
    for (const [id, cfg] of args.providers) {
      this.configs.set(id, cfg);
      this.adapters.set(id, this.createAdapter(cfg));
    }
  }

  /** Symmetric with LlmRouter.upsertConfig(). */
  upsertConfig(config: TtsProviderConfig): void {
    this.configs.set(config.id, config);
    this.adapters.set(config.id, this.createAdapter(config));
  }

  /** Symmetric with LlmRouter.removeConfig(). */
  removeConfig(providerId: string): void {
    this.configs.delete(providerId);
    this.adapters.delete(providerId);
  }

  private createAdapter(cfg: TtsProviderConfig): TtsAdapter {
    switch (cfg.protocol) {
      case 'openai-tts':     return new OpenAiTtsAdapter(cfg);
      case 'gpt-sovits-tts': return new GptSoVitsTtsAdapter(cfg);
      case 'dashscope-tts':  return new DashscopeTtsAdapter(cfg);
    }
  }

  /** Symmetric with LlmRouter.firstProviderId(). */
  firstProviderId(): string | undefined {
    return this.configs.keys().next().value;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Synthesize text into a stream of audio chunks. Sentence-level streaming:
   * the input text is split into sentences, each synthesized in turn.
   *
   * Uses request.providerId directly to find the adapter — symmetric with
   * LlmRouter.stream(request). No binding lookup inside the client.
   *
   * If the first sentence fails on the primary provider AND no audio has been
   * emitted yet, the service retries from scratch with the fallback provider.
   * If audio has already streamed, errors abort (no swap mid-flight).
   */
  async *synthesize(req: TtsRequest): AsyncIterable<TtsStreamEvent> {
    const cleaned = filterTextForTts(req.text, { turnMode: req.turnMode });
    if (cleaned.length === 0) {
      yield { type: 'done', totalBytes: 0, firstByteMs: 0 };
      return;
    }

    const adapter = this.adapters.get(req.providerId);
    const cfg     = this.configs.get(req.providerId);
    if (!adapter || !cfg) {
      yield { type: 'error', code: 'permanent_bad_request',
              message: `tts/provider not registered: "${req.providerId}"` };
      return;
    }

    const primaryVoice = this.resolveVoice(req.characterId, req.providerId, cfg);
    if (primaryVoice) {
      const result = yield* this.streamAllSentences(cleaned, adapter, cfg, primaryVoice, req);
      if (result.ok) return;
      // Only fall back if NO audio went out
      if (result.bytesEmitted > 0) return;
    }

    // ── Attempt 2: fallback ───────────────────────────────────────────────
    if (!this.fallback) {
      yield { type: 'error', code: 'unknown',
              message: 'primary tts failed and no fallback provider configured' };
      return;
    }

    const fbAdapter = this.adapters.get(this.fallback.providerId);
    const fbCfg     = this.configs.get(this.fallback.providerId);
    if (!fbAdapter || !fbCfg) {
      yield { type: 'error', code: 'permanent_bad_request',
              message: `tts/fallback provider not registered: "${this.fallback.providerId}"` };
      return;
    }

    const fallbackVoice = this.resolveVoice(null, this.fallback.providerId, fbCfg);
    if (!fallbackVoice) {
      yield { type: 'error', code: 'permanent_bad_request',
              message: 'fallback provider has no voice — cannot synthesize' };
      return;
    }

    const result = yield* this.streamAllSentences(cleaned, fbAdapter, fbCfg, fallbackVoice, req);
    if (!result.ok) {
      yield { type: 'error', code: 'unknown', message: 'fallback tts also failed' };
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private resolveVoice(
    characterId: CharacterCardId | null,
    providerId:  string,
    cfg:         TtsProviderConfig,
  ): TtsVoiceRef | null {
    // Read voiceId from the config (wiring layer pushes binding.voiceId into config)
    const voiceId = (cfg as unknown as { voiceId?: string | null }).voiceId ?? null;

    if (characterId && protocolSupportsVoiceKind(cfg.protocol, 'clone')) {
      const profile = this.voiceProfiles.getVoiceProfile(characterId);
      const primary = pickPrimaryRefAudio(profile);
      if (primary) {
        return {
          kind:         'clone',
          refAudioPath: this.refPathResolver.resolve(primary.refAudioPath),
          promptText:   primary.promptText,
          promptLang:   primary.promptLang,
        };
      }
    }

    if (voiceId && protocolSupportsVoiceKind(cfg.protocol, 'catalog')) {
      return { kind: 'catalog', voiceId };
    }

    return null;
  }

  private async *streamAllSentences(
    text:      string,
    adapter:   TtsAdapter,
    cfg:       TtsProviderConfig,
    voice:     TtsVoiceRef,
    req:       TtsRequest,
  ): AsyncGenerator<TtsStreamEvent, { ok: boolean; bytesEmitted: number }> {
    // Sanity: capability matrix guard
    if (!protocolSupportsVoiceKind(cfg.protocol, voice.kind)) {
      yield { type: 'error', code: 'permanent_unsupported_voice_kind',
              message: `protocol ${cfg.protocol} cannot use ${voice.kind} voice` };
      return { ok: false, bytesEmitted: 0 };
    }

    const splitter  = new SentenceSplitter();
    const sentences = [...splitter.feed(text), ...splitter.flush()];
    if (sentences.length === 0) {
      return { ok: true, bytesEmitted: 0 };
    }

    let bytesEmitted = 0;

    for (const sentence of sentences) {
      yield { type: 'sentence_started', index: sentence.index, text: sentence.text };

      const sentenceStart = Date.now();
      let sentenceErrored = false;

      const stream = adapter.stream({
        text:        sentence.text,
        model:       req.model,
        voice,
        format:      req.format ?? 'mp3',
        sampleRate:  req.sampleRate,
        speed:       req.speed,
        abortSignal: req.abortSignal,
      });

      for await (const ev of stream) {
        if (ev.type === 'audio_chunk') {
          bytesEmitted += ev.bytes.byteLength;
          yield ev;
        } else if (ev.type === 'error') {
          sentenceErrored = true;
          yield ev;
          break;
        } else if (ev.type === 'done') {
          yield { type: 'sentence_done', index: sentence.index,
                  durationMs: Date.now() - sentenceStart };
        } else {
          yield ev;
        }
      }

      if (sentenceErrored) {
        return { ok: false, bytesEmitted };
      }
    }

    yield { type: 'done', totalBytes: bytesEmitted, firstByteMs: 0 };
    return { ok: true, bytesEmitted };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pickPrimaryRefAudio(profile: CharacterVoiceProfile | null) {
  if (!profile || profile.refAudios.length === 0) return null;
  if (profile.primaryId) {
    const found = profile.refAudios.find((r) => r.id === profile.primaryId);
    if (found) return found;
  }
  return profile.refAudios[0]!;
}
