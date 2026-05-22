import type { Capability, ProviderDefinition } from './types.js';

import { provider as openai }      from './openai/index.js';
import { provider as anthropic }   from './anthropic/index.js';
import { provider as gemini }      from './gemini/index.js';
import { provider as deepseek }    from './deepseek/index.js';
import { provider as moonshot }    from './moonshot/index.js';
import { provider as zhipu }       from './zhipu/index.js';
import { provider as openrouter }  from './openrouter/index.js';
import { provider as groq }        from './groq/index.js';
import { provider as mistral }     from './mistral/index.js';
import { provider as xai }         from './xai/index.js';
import { provider as perplexity }  from './perplexity/index.js';
import { provider as together }    from './together/index.js';
import { provider as fireworks }   from './fireworks/index.js';
import { provider as ollama }      from './ollama/index.js';
import { provider as lmstudio }    from './lmstudio/index.js';
import { provider as siliconflow } from './siliconflow/index.js';
import { provider as jina }        from './jina/index.js';
import { provider as dashscope }   from './dashscope/index.js';
import { provider as gptSovits }   from './gpt-sovits/index.js';

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * The single source of truth for provider metadata. Adding a new provider:
 *   1. Create `providers/<id>/index.ts` exporting `provider`
 *   2. Import + add to this array
 *
 * DB stores only `provider_configs.definition_id` (the `id` string here).
 */
const ALL_DEFINITIONS: readonly ProviderDefinition[] = [
  openai, anthropic, gemini,
  deepseek, moonshot, zhipu, openrouter, groq, mistral, xai, perplexity,
  together, fireworks, ollama, lmstudio,
  siliconflow, jina,
  dashscope, gptSovits,
];

export const PROVIDER_DEFINITIONS: Readonly<Record<string, ProviderDefinition>> =
  Object.freeze(
    Object.fromEntries(ALL_DEFINITIONS.map((def) => [def.id, def])),
  );

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Look up a provider definition by id. Returns `undefined` for unknown ids
 * (e.g. a DB row whose definition_id was removed from the registry).
 */
export function getProviderDefinition(id: string): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS[id];
}

/** All providers that declare a given capability. */
export function providersWithCapability(
  capability: Capability,
): readonly ProviderDefinition[] {
  return ALL_DEFINITIONS.filter((def) => def.capabilities.includes(capability));
}

/** All definition ids in registration order. */
export function listProviderDefinitionIds(): readonly string[] {
  return ALL_DEFINITIONS.map((def) => def.id);
}
