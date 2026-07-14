/**
 * Diagnostics API — debug / introspection.
 * GET /api/diagnostics/hooks    HookBus trace ring buffer
 */
import { sidecarClient } from './sidecar-client.js';

export interface HookTraceEntry {
  sessionId:       string;
  turnId:          string;
  timestampMs:     number;
  event:           string;
  handlerName:     string;
  durationMs:      number;
  result:          'continue' | 'replace' | 'abort' | 'error';
  reason?:         string;
  payloadReplaced: boolean;
  failureKind?:    'handler_error' | 'timeout' | 'cancelled';
}

export interface HookDiagnosticsResult {
  traces: HookTraceEntry[];
  totalCaptured: number;
  summary: Record<HookTraceEntry['result'], number>;
  failures: HookTraceEntry[];
  slowest: HookTraceEntry[];
}

export const diagnosticsApi = {
  /** GET /api/diagnostics/hooks */
  async hooks(): Promise<HookDiagnosticsResult> {
    return sidecarClient.request<HookDiagnosticsResult>('/api/diagnostics/hooks');
  },
};
