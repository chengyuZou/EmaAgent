// 保存进程已经提供的 Tool，并按 Tool 自有来源完成 MCP 原子更新与注销。
import {
  ToolRegistrationConflictError,
  ToolRegistryError,
} from '../errors.js';
import type { Tool, ToolOrigin } from '../Tool/tool.js';

// Registry 需要容纳输入、输出、窄 Context 和进度类型各不相同的 Tool。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any, any, any>;
type McpToolOrigin = Extract<ToolOrigin, { readonly kind: 'mcp' }>;

/**
 * ToolRegistry 是进程级可变库存。
 *
 * Builtin 在启动装配时注册，MCP 在连接或重连时原子替换自己的实现。当前根
 * Turn 已经持有的 ToolPool 不会回读 Registry，因此热更新只影响下一根 Turn。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (tool.origin.kind !== 'builtin') {
      throw new ToolRegistryError(`MCP tool "${tool.name}" must use registerMcpBatch()`);
    }
    if (this.tools.has(tool.name)) {
      throw new ToolRegistryError(`Tool "${tool.name}" is already registered`);
    }
    this.assertIdAvailable(tool);
    this.tools.set(tool.name, tool);
  }

  /**
   * 原子注册一次 MCP 工具清单。
   *
   * 整批先完成名称、稳定 ID 和原始 Server/Tool 来源校验，再统一替换。清洗后
   * 同名的不同 MCP 工具、内置工具和其他 Server 的实现都不能被覆盖。
   */
  registerMcpBatch(tools: readonly AnyTool[]): void {
    const batchByName = new Map<string, AnyTool>();
    const batchById = new Map<string, AnyTool>();

    for (const tool of tools) {
      if (tool.origin.kind !== 'mcp') {
        throw new ToolRegistryError(`Builtin tool "${tool.name}" must use register()`);
      }

      const sameName = batchByName.get(tool.name);
      if (sameName) {
        throw new ToolRegistrationConflictError(
          tool.name,
          sameName.origin,
          tool.origin,
        );
      }
      batchByName.set(tool.name, tool);

      const sameId = batchById.get(tool.id);
      if (sameId && sameId.name !== tool.name) {
        throw new ToolRegistryError(
          `Tool id "${tool.id}" is shared by "${sameId.name}" and "${tool.name}"`,
        );
      }
      batchById.set(tool.id, tool);

      const registeredByName = this.tools.get(tool.name);
      if (registeredByName && !sameOrigin(registeredByName.origin, tool.origin)) {
        throw new ToolRegistrationConflictError(
          tool.name,
          registeredByName.origin,
          tool.origin,
        );
      }
      this.assertIdAvailable(tool);
    }

    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /** 只注销与原始 MCP Server/Tool 身份完全一致的实现。 */
  unregisterMcp(serverName: string, serverToolName: string): boolean {
    for (const [name, tool] of this.tools) {
      if (
        tool.origin.kind === 'mcp'
        && tool.origin.serverName === serverName
        && tool.origin.serverToolName === serverToolName
      ) {
        this.tools.delete(name);
        return true;
      }
    }
    return false;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): readonly AnyTool[] {
    return [...this.tools.values()];
  }

  private assertIdAvailable(attempted: AnyTool): void {
    for (const existing of this.tools.values()) {
      if (existing.id === attempted.id && existing.name !== attempted.name) {
        throw new ToolRegistryError(
          `Tool id "${attempted.id}" is already registered by "${existing.name}"`,
        );
      }
    }
  }
}

function sameOrigin(left: ToolOrigin, right: McpToolOrigin): boolean {
  return left.kind === 'mcp'
    && left.serverName === right.serverName
    && left.serverToolName === right.serverToolName;
}
