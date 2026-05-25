import type {
  TtsRequest,
  TtsStreamEvent,
  TtsAdapter,
  TtsProviderConfig,
} from './types.js';

import { OpenAiTtsAdapter }   from './adapters/openai-tts.js';
import { GptSoVitsTtsAdapter } from './adapters/gpt-sovits-tts.js';
import { DashscopeTtsAdapter } from './adapters/dashscope-tts.js';

import { filterTextForTts } from './streaming/text-filter.js';

// ── TtsClient ───────────────────────────────────────────────────────────────

/**
 * Text-to-Speech router. Pattern aligned with LlmRouter:
 *
 *   - adapters: Map<providerId, TtsAdapter>     (id → instance)
 *   - configs:  Map<providerId, TtsProviderConfig> (id → config)
 *
 * TtsClient is a DUMB DISPATCHER. It has no knowledge of characters,
 * voice profiles, file paths, URI caching, or fallback strategies.
 * Those concerns live in apps/core (the orchestrator layer).
 *
 * synthesize(request) receives a fully-resolved TtsVoiceRef — the caller
 * is responsible for resolving the voice from the character card and
 * ensuring voiceUri is populated before calling.
 */
export class TtsClient {
  /** providerId → adapter instance (hot-reloadable) */
  private adapters = new Map<string, TtsAdapter>();
  /** providerId → config */
  private configs  = new Map<string, TtsProviderConfig>();

  /**
   * @param configs           Provider configurations (from profile.db).
   * @param adapterOverrides  Pre-built adapters keyed by provider id (tests inject mocks here).
   */
  constructor(
    configs: TtsProviderConfig[],
    adapterOverrides?: ReadonlyMap<string, TtsAdapter>,
  ) {
    for (const cfg of configs) {
      this.configs.set(cfg.id, cfg);
      const override = adapterOverrides?.get(cfg.id);
      this.adapters.set(cfg.id, override ?? this.createAdapter(cfg));
    }
    // Allow overrides for provider ids that have no ProviderConfig (pure mock injection)
    if (adapterOverrides) {
      for (const [id, adapter] of adapterOverrides) {
        if (!this.adapters.has(id)) this.adapters.set(id, adapter);
      }
    }
  }

  // ── Hot-reload ─────────────────────────────────────────────────────────────

  reload(configs: TtsProviderConfig[]): void {
    this.adapters = new Map();
    this.configs  = new Map();
    for (const cfg of configs) {
      this.configs.set(cfg.id, cfg);
      this.adapters.set(cfg.id, this.createAdapter(cfg));
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

  /** Symmetric with LlmRouter.firstProviderId(). */
  firstProviderId(): string | undefined {
    return this.configs.keys().next().value;
  }

  /** Get the adapter for a provider id (for voice resolution / cache management). */
  getAdapter(providerId: string): TtsAdapter | undefined {
    return this.adapters.get(providerId);
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
   * Synthesize a single text segment into audio chunks.
   *
   * The caller (TtsCoordinator) is responsible for:
   *   1. Sentence splitting — each synthesize() call receives ONE sentence.
   *   2. Voice resolution — request.voice is a fully-resolved TtsVoiceRef
   *      with voiceUri already populated (by apps/core before calling).
   *   3. Error handling — TtsClient emits TtsStreamEvent.error; the caller
   *      decides whether to retry, fall back, or surface to the user.
   *
   * TtsClient only:
   *   1. Cleans text (strip markdown/code/ACT markers).
   *   2. Looks up the adapter by request.providerId.
   *   3. Delegates to adapter.stream().
   */
  async *synthesize(req: TtsRequest): AsyncIterable<TtsStreamEvent> {
    const cleaned = filterTextForTts(req.text, { turnMode: req.turnMode });
    if (cleaned.length === 0) {
      yield { type: 'done', totalBytes: 0, firstByteMs: 0 };
      return;
    }

    const adapter = this.adapters.get(req.providerId);
    if (!adapter) {
      yield { type: 'error', code: 'permanent_bad_request',
              message: `tts/provider not registered: "${req.providerId}"` };
      return;
    }

    if (!req.voice.voiceUri) {
      yield { type: 'error', code: 'permanent_refaudio_missing',
              message: 'voice has no voiceUri — caller must resolve before synthesize' };
      return;
    }

    // Ensure format has a default for adapters that consume it
    req.format ??= 'mp3';
    // Replace text with cleaned version (adapter reads req.text directly)
    req.text = cleaned;

    yield* adapter.stream(req);
  }
}
