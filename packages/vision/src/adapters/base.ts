import type {
  VisionExtractionResult,
  VisionParseMode,
  VisionProbeResult,
  VisionRequest,
  VisionTask,
} from '../types.js';

/**
 * Normalized per-call shape passed to adapters after the router fills in
 * defaults (task, parseMode). Extends VisionRequest with required task/parseMode.
 */
export interface VisionAdapterCall extends Omit<VisionRequest, 'task' | 'parseMode'> {
  task:      VisionTask;
  parseMode: VisionParseMode;
}

/** Contract every provider adapter must satisfy. */
export interface VisionAdapter {
  extract(request: VisionAdapterCall): Promise<VisionExtractionResult>;
  /** Optional health check — router falls back to a generic error if absent. */
  probe?(model: string, signal?: AbortSignal): Promise<VisionProbeResult>;
}
