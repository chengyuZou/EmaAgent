import type { ToolSpec } from "@ema-agent/core-types"

export type ToolRisk = "low" | "medium" | "high" | "critical"

export type BuiltinToolName =
  | "read_file"
  | "list_dir"
  | "search_text"
  | "write_file"
  | "run_command"
  | "run_python"

export interface ToolDescriptor {
  /** 模型和工具执行器共同使用的稳定名称。 */
  name: string
  /** 给用户看的短标题。 */
  displayName: string
  /** 给模型看的能力说明，会转换成 ToolSpec.description。 */
  description: string
  /** JSON Schema 参数定义，直接复用模型工具调用协议。 */
  parameters: Record<string, unknown>
  /** 默认风险级别，权限引擎会结合参数再细分。 */
  risk: ToolRisk
  /** 是否默认启用；用户设置页后续可以覆盖。 */
  enabledByDefault: boolean
  /** 是否需要工作区沙箱。 */
  requiresSandbox: boolean
  /** 是否可能写文件。 */
  writesFiles: boolean
  /** 是否可能访问网络。 */
  needsNetwork: boolean
}

export interface ToolExecutionContext {
  /** 工具执行开始时间，方便外层做 trace。 */
  startedAt?: number
}

export interface ToolExecutionResult {
  toolName: string
  success: boolean
  resultStr: string
  durationMs: number
  /** 结构化结果给后端内部使用；跨 SSE 边界仍然以 resultStr 为准。 */
  data?: unknown
}

export function descriptorToToolSpec(descriptor: ToolDescriptor): ToolSpec {
  return {
    name: descriptor.name,
    description: descriptor.description,
    parameters: descriptor.parameters,
  }
}
