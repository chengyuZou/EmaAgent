import type { CharacterVoiceProfile, CharacterCardId } from '@ema-agent/contracts';
import type {
  TtsRequest,
  TtsStreamEvent,
  TtsVoiceRef,
  TtsAdapter,
  TtsProviderConfig,
} from './types.js';

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
 * V1 is clone-only: each character must have a reference audio. If a card
 * has no refAudio, resolveVoice returns null and synthesize emits an error.
 * There is no system-voice fallback — the frontend is responsible for
 * disabling TTS when a character lacks voice configuration.
 */
export class TtsClient {
  /** providerId → adapter instance (hot-reloadable) */
  private adapters = new Map<string, TtsAdapter>();
  /** providerId → config (kept for capability checks) */
  private configs  = new Map<string, TtsProviderConfig>();

  // Read-only across reloads
  private readonly voiceProfiles:    VoiceProfileLookup;
  private readonly refPathResolver:  VoiceRefPathResolver;

  constructor(args: TtsClientArgs) {
    this.voiceProfiles   = args.voiceProfiles;
    this.refPathResolver = args.refPathResolver;
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
  }): void {
    this.adapters = new Map<string, TtsAdapter>();
    this.configs  = new Map<string, TtsProviderConfig>();
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
   * V1 is clone-only, single-attempt. If the character has no refAudio,
   * resolveVoice returns null → emit error. If uploadVoice fails → emit
   * error. No fallback — the frontend handles the UX (disabled button,
   * upload prompt).
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

    const voice = this.resolveVoice(req.characterId);
    if (!voice) {
      yield { type: 'error', code: 'permanent_refaudio_missing',
              message: 'character has no reference audio — TTS disabled' };
      return;
    }

    // ── Lazy upload: if voice has no URI yet, upload now ───────────────
    if (!voice.voiceUri) {
      try {
        voice.voiceUri = await this.ensureVoiceUri(adapter, voice, req.model);
      } catch (err) {
        yield { type: 'error', code: 'permanent_refaudio_missing',
                message: `voice upload failed: ${(err as Error).message}` };
        return;
      }
    }

    yield* this.streamAllSentences(cleaned, adapter, cfg, voice, req);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async ensureVoiceUri(
    adapter: TtsAdapter,
    voice:   TtsVoiceRef,
    model:   string,
  ): Promise<string> {
    if (!adapter.uploadVoice) {
      throw new Error(`adapter ${adapter.protocol} does not support voice upload`);
    }
    return adapter.uploadVoice(
      voice.refAudioPath,
      voice.promptText,
      voice.promptLang,
      model,
    );
  }

  private resolveVoice(
    characterId: CharacterCardId | null,
  ): TtsVoiceRef | null {
    if (!characterId) return null;

    const profile = this.voiceProfiles.getVoiceProfile(characterId);
    const primary = pickPrimaryRefAudio(profile);
    if (!primary) return null;

    return {
      refAudioPath: this.refPathResolver.resolve(primary.refAudioPath),
      promptText:   primary.promptText,
      promptLang:   primary.promptLang,
    };
  }

  private async *streamAllSentences(
    text:      string,
    adapter:   TtsAdapter,
    cfg:       TtsProviderConfig,
    voice:     TtsVoiceRef,
    req:       TtsRequest,
  ): AsyncGenerator<TtsStreamEvent, { ok: boolean; bytesEmitted: number }> {
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
