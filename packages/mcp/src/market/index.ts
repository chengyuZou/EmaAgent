export { McpMarketAdapter } from './adapter.js';
export { MCP_SEEDS } from './seeds/index.js';
// 各 type handler 的 list 也导出(供 ad-hoc / 测试 / 路由直接调单源)
export { list as listMcpRegistrySource, validateConfig as validateMcpRegistryConfig } from './adapters/mcp-registry.js';
export { list as listJsonIndexSource,   validateConfig as validateJsonIndexConfig }   from './adapters/json-index.js';
export type { McpSourceTypeHandler } from './adapters/index.js';
export type {
  McpMarketEntry,
  McpRegistryConfig,
  McpJsonIndexConfig,
  McpJsonIndexEntry,
  McpJsonIndex,
} from './types.js';
