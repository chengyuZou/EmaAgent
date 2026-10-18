import type { McpMarketSource } from './market/types.js';

export type McpServersChangedEvent = { readonly type: 'mcp_servers_changed' };

export type McpEvent =
  | McpServersChangedEvent
  | { readonly type: 'mcp_connection_changed' }
  | { readonly type: 'mcp_market_changed'; readonly source: McpMarketSource };
