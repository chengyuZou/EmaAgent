import { sidecarClient } from './sidecar-client.js';

export interface DiskInfoWire {
  mount: string;
  label: string;
  total: number;
  free:  number;
}

export interface SystemInfoWire {
  disks:   DiskInfoWire[];
  dataDir: string;
}

/** 与 LocalHost 组装的 SandboxStatusWire 同形；desktop-ui 不依赖后端包，本地镜像。 */
export interface SandboxStatusWire {
  readonly kind: 'bubblewrap' | 'sandbox-exec' | 'unisolated';
  readonly isolation: 'os' | 'application-only';
  readonly shellExecution: 'isolated' | 'disabled' | 'unsafe-override';
  readonly sandboxNetwork: 'none' | 'full';
  readonly localMcpStdio: 'isolated' | 'disabled' | 'unsafe-override';
  readonly warning?: string;
}

export const systemApi = {
  getInfo(): Promise<SystemInfoWire> {
    return sidecarClient.request<SystemInfoWire>('/api/system/disks');
  },

  /** GET /api/system/sandbox — 当前机器真正启用的隔离等级。 */
  getSandboxStatus(): Promise<SandboxStatusWire> {
    return sidecarClient.request<SandboxStatusWire>('/api/system/sandbox');
  },
};
