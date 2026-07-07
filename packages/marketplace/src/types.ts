import type { MarketSourceRow } from '@ema-agent/storage';

// ── marketplace 底座 ──────────────────────────────────────────────────────────
//
// 纯底座:fetch 基建 + 通用源元数据 CRUD + adapter 注册表 + 聚合调度。
// 零 MCP/Skill 业务知识 —— kind 是 string 不约束,业务包(mcp/skill/未来 integration)
// 各自实现 MarketSourceAdapter 并注册。新 kind 接入零改底座。
//
// 与 mcp_servers / skills 表的区别:那俩是"已装实例",market_sources 是"从哪浏览"。

// ── 源元数据(存 DB)──────────────────────────────────────────────────────────

export interface MarketSourceRecord {
  id:         string;
  /** 'mcp' | 'skill' | 未来 'integration' —— 业务包填,底座不约束 */
  kind:       string;
  /** 'github' | 'mcp-registry' | 'json-index' —— 业务包定义 */
  type:       string;
  label:      string;
  /** JSON 字符串,结构由业务包 adapter 定义(github: owner/repo/ref;mcp-registry: baseUrl/mirrorUrl;…) */
  config:     string;
  enabled:    boolean;
  /** builtin 不可删,只能启停 */
  builtin:    boolean;
  sortOrder:  number;
  createdAt:  number;
}

export function rowToRecord(row: MarketSourceRow): MarketSourceRecord {
  return {
    id:        row.id,
    kind:      row.kind,
    type:      row.type,
    label:     row.label,
    config:    row.config,
    enabled:   row.enabled === 1,
    builtin:   row.builtin === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

// ── Adapter 接口(业务包实现)──────────────────────────────────────────────────

/**
 * 一个业务包(mcp / skill / 未来 integration)实现此接口,注册到 MarketRegistry。
 * 底座只定义形状,不写具体 adapter。
 */
export interface MarketSourceAdapter<Entry> {
  /** 该 adapter 服务的 kind,如 'mcp' / 'skill' */
  readonly kind:   string;
  /** 该 kind 支持的 source type 列表,如 ['mcp-registry', 'json-index'] */
  readonly types:  readonly string[];
  /** 列出该源所有可装条目。单源失败应抛 Error,由 registry 捕获标记 error */
  list(source: MarketSourceRecord): Promise<Entry[]>;
  /**
   * 校验用户自传 config(业务包各自规则),返回标准化 config JSON 字符串。
   * 用于 POST /api/market/sources 时在写入前校验。
   */
  validateConfig(type: string, config: unknown): { ok: true; config: string } | { ok: false; error: string };
}

// ── Builtin seed(业务包注册时提供)────────────────────────────────────────────

export interface MarketSourceSeed {
  id:        string;
  kind:      string;
  type:      string;
  label:     string;
  /** 已是合法 JSON 字符串,直接入库 */
  config:    string;
  sortOrder: number;
}
