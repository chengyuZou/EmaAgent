// 统一执行 Provider 各能力的连通性探测，并把真实结果写回健康状态。
import type { ConfiguredProvider, ProviderConfigurationStore } from './configuration.js';
import { ProviderConfigurationError } from './errors.js';
import type { Capability } from './types.js';

export interface ProviderProbeResult {
  ok: boolean;
  model: string;
  latencyMs: number | null;
  error?: string;
}

export interface ProviderProbeModelSource {
  firstEnabled(providerId: string, capability: Capability): string | undefined;
  firstCatalog(provider: ConfiguredProvider, capability: Capability): string | undefined;
}

export interface ProviderProbeExecutor {
  probe(
    providerId: string,
    capability: Capability,
    model: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
}

export interface ProviderHealthRecorder {
  record(
    providerId: string,
    result: { ok: boolean; latencyMs?: number; error?: string },
  ): void;
}

const MODEL_PROBE_CAPABILITIES = new Set<Capability>([
  'llm',
  'embed',
  'rerank',
  'vision',
]);

export class ProviderProbe {
  constructor(
    private readonly configurations: Pick<ProviderConfigurationStore, 'get'>,
    private readonly models: ProviderProbeModelSource,
    private readonly executor: ProviderProbeExecutor,
    private readonly health: ProviderHealthRecorder,
  ) {}

  async run(
    providerId: string,
    capability: Capability,
    requestedModel: string | undefined,
    signal?: AbortSignal,
  ): Promise<ProviderProbeResult> {
    const provider = this.requireCapability(providerId, capability);
    const model = MODEL_PROBE_CAPABILITIES.has(capability)
      ? requestedModel
        ?? this.models.firstEnabled(providerId, capability)
        ?? this.models.firstCatalog(provider, capability)
      : undefined;

    if (MODEL_PROBE_CAPABILITIES.has(capability) && !model) {
      return {
        ok: false,
        model: '',
        latencyMs: null,
        error: '没有可探测的模型，请先在下方「模型」启用一个',
      };
    }

    const result = await this.executor.probe(
      providerId,
      capability,
      model,
      signal,
    );
    this.health.record(providerId, result);
    return {
      ok: result.ok,
      model: model ?? '',
      latencyMs: result.latencyMs ?? null,
      error: result.error,
    };
  }

  private requireCapability(
    providerId: string,
    capability: Capability,
  ): ConfiguredProvider {
    const provider = this.configurations.get(providerId);
    if (!provider) {
      throw new ProviderConfigurationError('not_found', 'Provider 不存在');
    }
    const enabled = provider.capabilities.some(
      (item) => item.capability === capability && item.enabled !== false,
    );
    if (!enabled) {
      throw new ProviderConfigurationError(
        'capability_not_supported',
        `Provider 未启用 ${capability} 能力`,
      );
    }
    return provider;
  }
}
