import type { SttAdapter, SttProviderConfig } from './types.js';
import type { SttRequest, SttResponse } from '@ema-agent/contracts';
import { OpenAiSttAdapter } from './adapters/openai-stt.js';

// ── SttClient Façade ────────────────────────────────────────────────────────
//
// Symmetric to TtsClient but radically simpler:
//   - One binding (no per-module differentiation; users transcribe with one
//     STT setting regardless of which mode they're in).
//   - Synchronous one-shot (no streaming for V1 — full audio in, full text out).
//   - No failover (no concept of "primary" vs "fallback" for STT in V1).

export interface SttBinding {
  providerConfigId: string;
  model:            string;
}

export interface SttClientArgs {
  providers: ReadonlyMap<string, SttProviderConfig>;
  binding:   SttBinding | null;
  adapterOverrides?: ReadonlyMap<string, SttAdapter>;
}

export class SttClient {
  // Mutable — see TtsClient.reload() doc for rationale.
  private providers: ReadonlyMap<string, SttProviderConfig>;
  private binding:   SttBinding | null;
  private adapters   = new Map<string, SttAdapter>();

  constructor(args: SttClientArgs) {
    this.providers = args.providers;
    this.binding   = args.binding;
    this.rebuildAdapters(args.adapterOverrides);
  }

  reload(args: {
    providers: ReadonlyMap<string, SttProviderConfig>;
    binding:   SttBinding | null;
  }): void {
    this.providers = args.providers;
    this.binding   = args.binding;
    this.adapters  = new Map<string, SttAdapter>();
    this.rebuildAdapters();
  }

  private rebuildAdapters(overrides?: ReadonlyMap<string, SttAdapter>): void {
    for (const [id, cfg] of this.providers) {
      const override = overrides?.get(id);
      this.adapters.set(id, override ?? this.createAdapter(cfg));
    }
  }

  private createAdapter(cfg: SttProviderConfig): SttAdapter {
    switch (cfg.protocol) {
      case 'openai-stt': return new OpenAiSttAdapter(cfg);
    }
  }

  isAvailable(): boolean {
    return this.binding !== null && this.adapters.has(this.binding.providerConfigId);
  }

  async transcribe(req: SttRequest): Promise<SttResponse> {
    if (!this.binding) {
      throw new Error('stt/not_configured: no STT binding set');
    }
    const adapter = this.adapters.get(this.binding.providerConfigId);
    if (!adapter) {
      throw new Error(`stt/not_configured: provider "${this.binding.providerConfigId}" not registered`);
    }
    return adapter.transcribe(req, this.binding.model);
  }
}
