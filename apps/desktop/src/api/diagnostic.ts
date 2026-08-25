// 读取后端公开的系统事件诊断快照。
import { sidecarClient } from './sidecar-client.js';

export interface SystemEventDiagnosticsResult {
  subscribers: number;
}

export const diagnosticsApi = {
  /** GET /api/system/events/diagnostics */
  async systemEvents(): Promise<SystemEventDiagnosticsResult> {
    return sidecarClient.request<SystemEventDiagnosticsResult>('/api/system/events/diagnostics');
  },
};
