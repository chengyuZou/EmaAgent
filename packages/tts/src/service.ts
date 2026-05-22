import type {
  TtsRequest,
  TtsStreamEvent,
  TtsModule,
  TtsVoiceRef,
  CharacterVoiceProfile,
  CharacterCardId,
} from '@ema-agent/contracts';
import type {
  TtsAdapter,
  TtsProviderConfig,
  TtsModuleBinding,
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
   * Primary binding per module. Reads `model_bindings` for module IN
   * ('chat','narrative','agent') where capability is tts.
   */
  primaryBindings:  ReadonlyMap<TtsModule, TtsModuleBinding>;
  /**
   * Optional fallback binding per module. Reads `model_bindings` where module
   * is a future synthetic `chat_fallback` / `narrative_fallback` / etc. — for
   * V1 we share a single binding key `__tts_fallback__` across all modules.
   */
  fallbackBinding?: TtsModuleBinding;
  voiceProfiles:    VoiceProfileLookup;
  refPathResolver:  VoiceRefPathResolver;
  /** For tests: pre-built adapters keyed by providerConfigId. */
  adapterOverrides?: ReadonlyMap<string, TtsAdapter>;
}

// ── TtsClient ───────────────────────────────────────────────────────────────

/**
 * Single Façade for all TTS access. Upper layers pass `characterId` + `module`
 * + text; the client resolves voice, picks the adapter, and on failure of the
 * primary attempt falls through to the configured system fallback voice.
 *
 * V1 failover model (memory:project-tts-scope):
 *   primary refAudio fails  → system fallback voice (catalog, different binding)
 *   fallback also fails     → emit error, stream ends without audio
 *
 * No cycling through secondary refAudios — that is deferred to a later round.
 */
export class TtsClient {
  private readonly providers:        ReadonlyMap<string, TtsProviderConfig>;
  private readonly primary:          ReadonlyMap<TtsModule, TtsModuleBinding>;
  private readonly fallback:         TtsModuleBinding | undefined;
  private readonly voiceProfiles:    VoiceProfileLookup;
  private readonly refPathResolver:  VoiceRefPathResolver;
  private readonly adapters          = new Map<string, TtsAdapter>();

  constructor(args: TtsClientArgs) {
    this.providers       = args.providers;
    this.primary         = args.primaryBindings;
    this.fallback        = args.fallbackBinding;
    this.voiceProfiles   = args.voiceProfiles;
    this.refPathResolver = args.refPathResolver;

    for (const [id, cfg] of this.providers) {
      const override = args.adapterOverrides?.get(id);
      this.adapters.set(id, override ?? this.createAdapter(cfg));
    }
  }

  private createAdapter(cfg: TtsProviderConfig): TtsAdapter {
    switch (cfg.protocol) {
      case 'openai-tts':     return new OpenAiTtsAdapter(cfg);
      case 'gpt-sovits-tts': return new GptSoVitsTtsAdapter(cfg);
      case 'dashscope-tts':  return new DashscopeTtsAdapter(cfg);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Synthesize text into a stream of audio chunks. Sentence-level streaming:
   * the input text is split into sentences, each synthesized in turn. The
   * service emits `sentence_started` / `sentence_done` around each.
   *
   * If the first sentence fails on the primary binding AND no audio has been
   * emitted yet, the service retries from scratch with the fallback binding.
   * If audio has already streamed, errors abort the stream (no swap mid-flight).
   */
  async *synthesize(req: TtsRequest): AsyncIterable<TtsStreamEvent> {
    const cleaned = filterTextForTts(req.text, { module: req.module });
    if (cleaned.length === 0) {
      yield { type: 'done', totalBytes: 0, firstByteMs: 0 };
      return;
    }

    const primaryBinding = this.primary.get(req.module);
    if (!primaryBinding) {
      yield { type: 'error', code: 'permanent_bad_request',
              message: `no model_bindings.tts row for module "${req.module}"` };
      return;
    }

    // ── Attempt 1: primary binding ────────────────────────────────────────
    const primaryVoice = this.resolveVoice(req.characterId, primaryBinding);
    if (primaryVoice) {
      const result = yield* this.streamAllSentences(cleaned, primaryBinding, primaryVoice, req);
      if (result.ok) return;
      // Only fall back if NO audio went out — see service docstring
      if (result.bytesEmitted > 0) return;
    }

    // ── Attempt 2: fallback binding (system voice) ────────────────────────
    if (!this.fallback) {
      yield { type: 'error', code: 'unknown',
              message: 'primary tts failed and no fallback binding configured' };
      return;
    }

    const fallbackVoice = this.resolveVoice(null, this.fallback);
    if (!fallbackVoice) {
      yield { type: 'error', code: 'permanent_bad_request',
              message: 'fallback binding has no voiceId — cannot synthesize' };
      return;
    }

    const result = yield* this.streamAllSentences(cleaned, this.fallback, fallbackVoice, req);
    if (!result.ok) {
      yield { type: 'error', code: 'unknown',
              message: 'fallback tts also failed' };
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Resolve voice from a binding + optional character. Returns null when:
   *   - cardId points at a card whose refAudios are empty / primary missing
   *     AND the binding's protocol cannot do catalog voices
   *
   * Voice resolution priority:
   *   1. If binding.protocol supports `clone` AND character has a primary
   *      refAudio → use clone
   *   2. Else if binding.protocol supports `catalog` AND binding.voiceId set
   *      → use catalog
   *   3. Else → null (caller falls through to next binding)
   */
  private resolveVoice(
    characterId: CharacterCardId | null,
    binding:     TtsModuleBinding,
  ): TtsVoiceRef | null {
    const cfg = this.providers.get(binding.providerConfigId);
    if (!cfg) return null;

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

    if (binding.voiceId && protocolSupportsVoiceKind(cfg.protocol, 'catalog')) {
      return { kind: 'catalog', voiceId: binding.voiceId };
    }

    return null;
  }

  /**
   * Sentence-by-sentence synthesis against one binding. Returns whether all
   * sentences succeeded and how many bytes were emitted (needed by the
   * fallback decision in `synthesize`).
   */
  private async *streamAllSentences(
    text:    string,
    binding: TtsModuleBinding,
    voice:   TtsVoiceRef,
    req:     TtsRequest,
  ): AsyncGenerator<TtsStreamEvent, { ok: boolean; bytesEmitted: number }> {
    const cfg     = this.providers.get(binding.providerConfigId);
    const adapter = this.adapters.get(binding.providerConfigId);
    if (!cfg || !adapter) {
      yield { type: 'error', code: 'permanent_bad_request',
              message: `provider "${binding.providerConfigId}" not registered` };
      return { ok: false, bytesEmitted: 0 };
    }

    // Sanity: capability matrix should have been enforced by resolveVoice,
    // but guard anyway in case of misconfig
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
        model:       binding.model,
        voice,
        format:      req.format ?? 'mp3',
        sampleRate:  req.sampleRate,
        speed:       req.speed,
        instructions: typeof binding.config['instructions'] === 'string'
          ? binding.config['instructions'] as string
          : undefined,
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
