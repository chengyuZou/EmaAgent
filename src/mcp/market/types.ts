// 这里定义 MCP 市场条目和不同市场源的配置类型。
// ── MCP market 条目类型 ───────────────────────────────────────────────────────
//
// 从路由层搬来(原 apps/localHost/src/routes/mcp.ts:37-48),供 adapter + 路由共用。

export interface McpMarketEntry {
  name:         string;
  title?:       string;
  description?: string;
  version?:     string;
  repository?:  string;
  websiteUrl?:  string;
  transport:    'stdio' | 'http' | null;
  url?:         string;
  command?:     string;
  args?:        string[];
  /** false 时只展示，后端没有足够信息生成不可漂移的安装配置。 */
  installable:  boolean;
  unavailableReason?: string;
  marketSourceId?:   string;
  marketSourceType?: string;
  packageRegistry?:  'npm' | 'pypi';
  packageName?:      string;
  packageVersion?:   string;
  packageIntegrity?: string;
}

// ── 各 source type 的 config 结构(存 market_sources.config JSON)───────────────

/** type='mcp-registry':官方 registry cursor 分页 API */
export interface McpRegistryConfig {
  baseUrl:    string;
  mirrorUrl?: string;
}

/** type='json-index':用户自传的 JSON 索引 URL */
export interface McpJsonIndexConfig {
  indexUrl:   string;
  mirrorUrl?: string;
}

// ── 通用 JSON 索引条目(json-index type 解析这个)──────────────────────────────
//
// 约定格式:{ entries: McpJsonIndexEntry[] }
// 字段尽量宽松,缺 transport 的条目由 normaliser 推断。

export interface McpJsonIndexEntry {
  name:        string;
  title?:      string;
  description?: string;
  version?:    string;
  repository?: string;
  websiteUrl?: string;
  transport?:  'stdio' | 'http';
  url?:        string;
  command?:    string;
  args?:       string[];
  packageRegistry?: 'npm' | 'pypi';
  packageName?: string;
  packageVersion?: string;
  packageIntegrity?: string;
}

export interface McpJsonIndex {
  entries: McpJsonIndexEntry[];
}
