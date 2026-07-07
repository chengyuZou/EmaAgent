import type { MarketSourceSeed } from '@ema-agent/marketplace';

// ── MCP 官方 registry 源 ──────────────────────────────────────────────────────
//
// registry.modelcontextprotocol.io 的 REST API,cursor 分页。
// 官方无内地镜像,直连失败用户可见 error(单源失败不阻断其他源)。

export const OFFICIAL_REGISTRY_SEED: MarketSourceSeed = {
  id:        'mcp-official-registry',
  kind:      'mcp',
  type:      'mcp-registry',
  label:     'MCP 官方 Registry',
  config:    JSON.stringify({ baseUrl: 'https://registry.modelcontextprotocol.io/v0/servers' }),
  sortOrder: 0,
};
