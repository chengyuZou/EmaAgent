import type { ModuleKey, ModuleBindings, ResolvedBinding, TtsBinding, SttBinding } from './types.js';
import type { ModelId } from '@ema-agent/contracts';

/**
 * Resolve the effective binding for a module slot.
 *
 * Priority: card-level override → global model_bindings (DB) → { kind: 'none' }
 *
 * V1: global fallback is a no-op stub; the full DB lookup will be wired in once
 * a ModelBindingsRepo is added to @ema-agent/storage.
 */
export function resolveBinding(
  module: ModuleKey,
  cardBindings: ModuleBindings,
  globalLookup?: (module: ModuleKey) => ResolvedBinding | undefined,
): ResolvedBinding {
  // Card-level override
  const card = cardBindings[module];

  if (module === 'tts') {
    const tts = card as TtsBinding | undefined;
    if (tts?.providerId) return { kind: 'tts', tts };
  } else if (module === 'stt') {
    const stt = card as SttBinding | undefined;
    if (stt?.providerId) return { kind: 'stt', stt };
  } else {
    const modelId = card as ModelId | undefined;
    if (modelId) return { kind: 'model', modelId };
  }

  // Global fallback
  if (globalLookup) {
    const global = globalLookup(module);
    if (global) return global;
  }

  return { kind: 'none' };
}
