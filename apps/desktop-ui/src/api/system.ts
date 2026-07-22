import { sidecarClient } from './sidecar-client.js';
import type { AppCapabilitiesWire, ReleaseFeaturesWire } from '@ema-agent/system';

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

/**
 * Fail-closed 默认特性集:未加载 / 请求失败 / 字段缺失时一律用这个。
 * 任何不确定都视作 Artifact 不可见,绝不让未完成功能入口漏出来。
 */
export const FEATURES_DISABLED: ReleaseFeaturesWire = Object.freeze({ artifacts: false });

export const systemApi = {
  getInfo(): Promise<SystemInfoWire> {
    return sidecarClient.request<SystemInfoWire>('/api/system/disks');
  },

  /**
   * GET /api/system/capabilities — V1 发布特性开关。
   * fail-closed:任何错误(网络/解析/字段缺失)都返回 FEATURES_DISABLED,
   * 调用方无需再 try/catch。
   */
  async getCapabilities(): Promise<AppCapabilitiesWire> {
    try {
      const body = await sidecarClient.request<AppCapabilitiesWire>('/api/system/capabilities');
      if (!body || typeof body !== 'object' || !body.features) return { release: 'v1', features: FEATURES_DISABLED };
      return body;
    } catch {
      return { release: 'v1', features: FEATURES_DISABLED };
    }
  },
};
