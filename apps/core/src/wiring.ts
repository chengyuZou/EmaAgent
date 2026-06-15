// Back-compat shim. The actual implementation moved into ./wiring/ during
// Round 5A to separate Façade construction, hook registration, and emitter
// wiring into three focused files. All existing consumers keep working
// through these re-exports; new code should import from './wiring/index.js'
// directly.

export {
  wire,
  buildLlmProviderConfig,
  buildEmbedProviderConfig,
  buildRerankProviderConfig,
  resolveBridgeUrl,
  configureBridge,
  fetchLlmModels,
  fetchEmbedModels,
  registerAllHooks,
  registerAllEmitters,
} from './wiring/index.js';

export type { AppBindings } from './wiring/index.js';
