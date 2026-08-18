// 把 Tool 契约投影为 UI 可渲染的工具目录项(工具管理页只读展示)。
// 只投影静态契约事实: 身份/来源/描述/结果预算/输入结构/结果投影方式。
// 不投影 per-input 行为(isReadOnly/isConcurrencySafe 依赖具体输入, 目录里
// 展示会误导), 也不制造 Tool 契约的新字段。

import { toJSONSchema } from 'zod';
import type { Tool } from './Tool/tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any, any, any>;

/** 工具目录项: 供前端工具管理页渲染的只读快照。 */
export interface ToolCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly kind: 'builtin' | 'mcp';
  /** kind === 'mcp' 时的来源 Server 名。 */
  readonly serverName?: string;
  /** kind === 'mcp' 时 Server 侧原始工具名。 */
  readonly serverToolName?: string;
  readonly description: string;
  /** 模型可见结果超过该 UTF-8 字节数时由结果层落盘(结果预算)。 */
  readonly maxResultBytes: number;
  /** inputSchema 的 JSON Schema 形态(含 .describe() 说明), UI 渲染只读参数说明。 */
  readonly inputSchema: Record<string, unknown>;
  /** 工具是否有自定义结果→模型内容投影(否则按 string/JSON 默认处理)。 */
  readonly hasCustomResultMapping: boolean;
}

/** 把 Tool 投影为目录项。inputSchema 转 JSON Schema 失败时回落最小结构描述。 */
export function describeToolForCatalog(tool: AnyTool): ToolCatalogItem {
  const origin = tool.origin;
  const inputSchema = toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  return {
    id: tool.id,
    name: tool.name,
    kind: origin.kind,
    ...(origin.kind === 'mcp'
      ? { serverName: origin.serverName, serverToolName: origin.serverToolName }
      : {}),
    description: tool.description,
    maxResultBytes: tool.maxResultBytes,
    inputSchema,
    hasCustomResultMapping: typeof tool.mapResultToModelContent === 'function',
  };
}
