/**
 * Diagnostics API — debug / introspection.
 * GET /api/diagnostics/hooks    HookBus trace ring buffer
 */
import { sidecarClient } from './sidecar-client.js';

export interface HookTraceEntry {
  event:       string;
  handlerName: string;
  durationMs:  number;
  result:      string;
  error?:      string;
}

export interface DiagnosticsResult {
  hooks: HookTraceEntry[];
}

export const diagnosticsApi = {
  /** GET /api/diagnostics/hooks */
  async hooks(): Promise<DiagnosticsResult> {
    return sidecarClient.request<DiagnosticsResult>('/api/diagnostics/hooks');
  },
};
