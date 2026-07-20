import type { Database, ProviderConfigRow } from '@ema-agent/storage';
import { ProvidersRepo } from '@ema-agent/storage';
import { VisionRouter, isVisionError } from '@ema-agent/vision';
import type { VisionProviderConfig, VisionImageMime } from '@ema-agent/vision';
import type { ModelsDevCatalog } from '@ema-agent/llm';
import type { CredentialFacade } from '@ema-agent/credential';
import { KbVisionAdapterError, type KbVisionAdapter } from '@ema-agent/knowledge-base';
import {
  providerCatalog,
  isVisionProtocol,
  requiresCredentials,
  staticModelsFor,
} from '@ema-agent/provider';
import type {
  UsageRecord,
  UsageRecorder,
} from '@ema-agent/contracts';
import {
  capabilityConfigFor,
  configuredBaseUrlFor,
  selectedProtocolFor,
} from './config-resolution.js';

export interface FetchedVisionModels {
  models: string[];
  source: 'catalog' | 'static';
}

/**
 * List the vision models a provider exposes.
 *
 * Priority:
 *   1. models.dev catalog — filter LLM models where inputModalities includes 'image'
 *   2. Provider definition's defaultModels.vision — offline/static fallback
 *   3. Empty — no vision models declared
 *
 * No live /v1/models fallback: vision has no dedicated live-listing endpoint,
 * and filtering a live LLM list by vision support isn't reliable.
 */
export async function fetchVisionModels(
  row: ProviderConfigRow,
  opts?: {
    modelsDevId?:  string;
    modelCatalog?: ModelsDevCatalog;
  },
): Promise<FetchedVisionModels> {
  const catalogModels = opts?.modelsDevId && opts?.modelCatalog
    ? opts.modelCatalog.listVisionModelIds(opts.modelsDevId)
    : [];

  if (catalogModels.length > 0) {
    return { models: catalogModels, source: 'catalog' };
  }

  const def = providerCatalog.get(row.definition_id);
  const staticModels = def ? staticModelsFor(def, 'vision') : [];
  return { models: [...staticModels], source: 'static' };
}

export function buildVisionProviderConfig(row: ProviderConfigRow): VisionProviderConfig | null {
  const def = providerCatalog.get(row.definition_id);
  if (!def) return null;

  const capability = capabilityConfigFor(row, 'vision');
  if (!capability) return null;

  const protocol = selectedProtocolFor(def, 'vision', capability);
  if (!isVisionProtocol(protocol)) return null;

  if (requiresCredentials(def) && !row.credential) return null;

  return {
    id:           row.id,
    protocol,
    apiKey:       row.credential ?? '',
    baseUrl:      configuredBaseUrlFor(def, 'vision', capability, protocol),
  };
}

function loadVisionConfigs(
  profileDb: Database,
  credentials: CredentialFacade,
): VisionProviderConfig[] {
  const repo = new ProvidersRepo(profileDb.sqlite, credentials);
  const out: VisionProviderConfig[] = [];
  for (const row of repo.listByCapability('vision')) {
    const cfg = buildVisionProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

export function buildVisionRouter(
  profileDb: Database,
  credentials: CredentialFacade,
  usageRecorder?: UsageRecorder,
  onUsageRecordError?: (error: unknown, record: UsageRecord) => void,
): VisionRouter {
  return new VisionRouter({
    configs: loadVisionConfigs(profileDb, credentials),
    usageRecorder,
    onUsageRecordError,
  });
}

export function reloadVisionRouter(
  router: VisionRouter,
  profileDb: Database,
  credentials: CredentialFacade,
): void {
  router.reload(loadVisionConfigs(profileDb, credentials));
}

/** Wraps VisionRouter as the KB-internal KbVisionAdapter interface. */
export function asKbVisionAdapter(router: VisionRouter): KbVisionAdapter {
  return {
    async extract({ providerId, model, task, inputs, signal }) {
      try {
        const result = await router.extract({
          providerId,
          model,
          task,
          inputs: inputs.map((inp) => ({
            kind: 'bytes' as const,
            bytes: inp.bytes,
            mimeType: inp.mimeType as VisionImageMime,
            name: inp.name,
          })),
          signal,
        });
        return {
          blocks: result.blocks.map((b) => ({ text: b.text, markdown: b.markdown })),
        };
      } catch (error) {
        if (isVisionError(error)) {
          throw new KbVisionAdapterError(error.code, error.meta.retryable === true, { cause: error });
        }
        throw error;
      }
    },
  };
}
