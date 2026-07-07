/**
 * Market API — 市场源管理(MCP/Skill/未来 integration 共用)。
 * 源存后端 market_sources 表,adapter 在 MarketRegistry 注册。
 */
import { sidecarClient } from './sidecar-client.js';

/** 一行 market_sources 记录。kind 不约束(mcp/skill/未来 integration)。 */
export interface MarketSourceRecord {
  id:        string;
  kind:      string;
  type:      string;
  label:     string;
  /** JSON 字符串,结构由业务包 adapter 定义 */
  config:    string;
  enabled:   boolean;
  builtin:   boolean;
  sortOrder: number;
  createdAt: number;
}

export interface MarketSourceTestResult {
  ok:     boolean;
  count?: number;
  error?: string;
  sample?: unknown[];
}

/** 某源 fetch 结果(聚合返回的单源分量) */
export interface MarketSourceMeta {
  id:      string;
  label:   string;
  type:    string;
  error?:  string;
  count:   number;
}

export const marketApi = {
  /** GET /api/market/sources?kind=... */
  async list(kind?: string): Promise<{ sources: MarketSourceRecord[] }> {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    return sidecarClient.request<{ sources: MarketSourceRecord[] }>(`/api/market/sources${query}`);
  },

  /** POST /api/market/sources — 创建用户源 */
  async create(input: {
    kind: string;
    type: string;
    label: string;
    config: Record<string, unknown>;
    sortOrder?: number;
  }): Promise<{ source: MarketSourceRecord }> {
    return sidecarClient.request<{ source: MarketSourceRecord }>('/api/market/sources', {
      method: 'POST',
      json:   input,
    });
  },

  /** PATCH /api/market/sources/:id — 改 label/enabled/config/sortOrder */
  async update(id: string, patch: {
    label?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
    sortOrder?: number;
  }): Promise<{ source: MarketSourceRecord }> {
    return sidecarClient.request<{ source: MarketSourceRecord }>(`/api/market/sources/${id}`, {
      method: 'PATCH',
      json:   patch,
    });
  },

  /** DELETE /api/market/sources/:id — 删(builtin 后端拒绝) */
  async remove(id: string): Promise<{ ok: boolean }> {
    return sidecarClient.request<{ ok: boolean }>(`/api/market/sources/${id}`, {
      method: 'DELETE',
    });
  },

  /** GET /api/market/sources/:id/test — 测已存源连通性 */
  async test(id: string): Promise<MarketSourceTestResult> {
    return sidecarClient.request<MarketSourceTestResult>(`/api/market/sources/${id}/test`);
  },

  /** POST /api/market/sources/test — 添加前先测(不存 DB) */
  async testByConfig(input: {
    kind: string;
    type: string;
    label: string;
    config: Record<string, unknown>;
  }): Promise<MarketSourceTestResult> {
    return sidecarClient.request<MarketSourceTestResult>('/api/market/sources/test', {
      method: 'POST',
      json:   input,
    });
  },
};
