import type { Database, ProviderConfigRow } from '@ema-agent/storage';
import { ProvidersRepo } from '@ema-agent/storage';
import { VisionRouter } from '@ema-agent/vision';
import type { VisionProviderConfig, VisionImageMime } from '@ema-agent/vision';
import type { KbVisionAdapter } from '@ema-agent/knowledge-base';
import {
  getProviderDefinition,
  isVisionProtocol,
  resolveProtocols,
  type ProtocolFamily,
} from '@ema-agent/contracts';

export function buildVisionProviderConfig(row: ProviderConfigRow): VisionProviderConfig | null {
  const def = getProviderDefinition(row.definition_id);
  if (!def) return null;

  const capabilities: string[] = JSON.parse(row.capabilities_json);
  if (!capabilities.includes('vision')) return null;

  const protocol = resolveProtocols(def.protocols.vision)[0] as ProtocolFamily | undefined;
  if (!isVisionProtocol(protocol)) return null;

  if (def.requiresCredentials !== false && !row.api_key_plain) return null;

  const extra = JSON.parse(row.config_json) as Record<string, unknown>;
  return {
    id:           row.id,
    protocol,
    apiKey:       row.api_key_plain ?? '',
    baseUrl:      row.base_url ?? def.defaultBaseUrl,
    defaultModel: typeof extra['defaultModel'] === 'string' ? extra['defaultModel'] : undefined,
  };
}

function loadVisionConfigs(profileDb: Database): VisionProviderConfig[] {
  const repo = new ProvidersRepo(profileDb.sqlite);
  const out: VisionProviderConfig[] = [];
  for (const row of repo.listByCapability('vision')) {
    const cfg = buildVisionProviderConfig(row);
    if (cfg) out.push(cfg);
  }
  return out;
}

export function buildVisionRouter(profileDb: Database): VisionRouter {
  return new VisionRouter({ configs: loadVisionConfigs(profileDb) });
}

export function reloadVisionRouter(router: VisionRouter, profileDb: Database): void {
  for (const cfg of loadVisionConfigs(profileDb)) {
    router.upsertConfig(cfg);
  }
}

/** Wraps VisionRouter as the KB-internal KbVisionAdapter interface. */
export function asKbVisionAdapter(router: VisionRouter): KbVisionAdapter {
  return {
    async extract({ providerId, model, inputs }) {
      const result = await router.extract({
        providerId,
        model,
        task: 'ocr',
        inputs: inputs.map((inp) => ({
          kind: 'bytes' as const,
          bytes: inp.bytes,
          mimeType: inp.mimeType as VisionImageMime,
          name: inp.name,
        })),
      });
      return {
        blocks: result.blocks.map((b) => ({ text: b.text, markdown: b.markdown })),
      };
    },
  };
}
