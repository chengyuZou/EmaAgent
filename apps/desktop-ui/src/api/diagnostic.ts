// 读取后端公开的 Hook 与系统事件诊断快照。
import { sidecarClient } from './sidecar-client.js';

export interface HookTraceEntry {
  invocationId:    string;
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

export interface SystemEventDiagnosticsResult {
  subscribers: number;
}

export const diagnosticsApi = {
  /** GET /api/diagnostics/hooks */
  async hooks(): Promise<HookDiagnosticsResult> {
    return sidecarClient.request<HookDiagnosticsResult>('/api/diagnostics/hooks');
  },

  /** GET /api/system/events/diagnostics */
  async systemEvents(): Promise<SystemEventDiagnosticsResult> {
    return sidecarClient.request<SystemEventDiagnosticsResult>('/api/system/events/diagnostics');
  },
};
