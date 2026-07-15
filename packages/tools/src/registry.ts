import { ZodError } from 'zod';
import type { BuiltTool, ToolDescriptor, ToolExecutionContext } from './types.js';
import { freezePreparedInput } from './prepared-call.js';
import type { PreparedToolCall } from './prepared-call.js';

// Type alias for a BuiltTool with erased generics — safe for registry storage.
// The `execute` parameter is contravariant so BuiltTool<X, Y> !<: BuiltTool<unknown, unknown>;
// we bypass this by using `unsafeExecute` which is already typed as (unknown) => Promise<unknown>.
type AnyBuiltTool = Omit<BuiltTool<never, unknown>, 'execute'> & {
  execute: BuiltTool<unknown, unknown>['execute'];
};

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

export class ToolInputError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly zodError: ZodError,
  ) {
    super(`Invalid input for tool "${toolName}": ${zodError.message}`);
    this.name = 'ToolInputError';
  }
}

/**
 * Central registry for all BuiltTool instances.
 *
 * Tools are registered once at startup by tool-builtin's registerBuiltinTools().
 * The AgentEngine calls dispatch() after PermissionEngine.gate() approves the call.
 */
export class ToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tools    = new Map<string, BuiltTool<any, any>>();
  /** Separate set tracks MCP-registered names for safe hot-swap. */
  private readonly mcpNames = new Set<string>();
  /** 运行时能力表：防止调用方伪造 PreparedToolCall 或跨 Registry 执行。 */
  private readonly preparedCalls = new WeakMap<object, BuiltTool<any, any>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(tool: BuiltTool<any, any>): void {
    if (this.tools.has(tool.name)) {
      throw new ToolRegistryError(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Register an MCP-sourced tool. Unlike register(), this is idempotent:
   * registering the same name replaces the existing entry without throwing.
   * Used by McpRegistry when a server (re)connects.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerMcp(tool: BuiltTool<any, any>): void {
    this.tools.set(tool.name, tool);
    this.mcpNames.add(tool.name);
  }

  /**
   * Remove an MCP-sourced tool. No-op if not registered.
   * Used by McpRegistry when a server disconnects.
   */
  unregisterMcp(name: string): void {
    if (!this.mcpNames.has(name)) return;
    this.tools.delete(name);
    this.mcpNames.delete(name);
  }

  /** Throws ToolRegistryError if the tool is not registered. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): BuiltTool<any, any> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolRegistryError(`Tool "${name}" is not registered`);
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  list(): BuiltTool<any, any>[] {
    return [...this.tools.values()];
  }

  descriptors(): ToolDescriptor[] {
    return this.list().map((t) => t.descriptor());
  }

  /**
   * 查找工具并完成一次且仅一次的输入解析。
   * 返回值同时供 Hook、PermissionEngine 和 execute() 使用。
   */
  prepare(name: string, rawArgs: unknown): PreparedToolCall {
    const tool = this.get(name);
    let parsed: unknown;
    try {
      parsed = tool.parseInput(rawArgs);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ToolInputError(name, err);
      }
      throw err;
    }

    const input = freezePreparedInput(parsed);
    // MCP 工具可能绕过 buildTool() 手工构造，因此这里统一建立权限策略快照。
    const permissionMeta = Object.freeze({ ...tool.permissionMeta });
    const prepared = Object.freeze({
      name,
      input,
      permissionMeta,
      isReadOnly: tool.isReadOnly(input),
      isConcurrencySafe: tool.isConcurrencySafe(input),
    }) satisfies PreparedToolCall;

    this.preparedCalls.set(prepared, tool);
    return prepared;
  }

  /**
   * 执行由本 Registry 准备的不可变调用。
   * MCP 热更新等注册表变化会让旧快照失效，避免审批旧实现却执行新实现。
   */
  async execute(
    prepared: PreparedToolCall,
    ctx: ToolExecutionContext,
  ): Promise<unknown> {
    const preparedObject = prepared as object;
    const preparedTool = this.preparedCalls.get(preparedObject);
    if (!preparedTool) {
      throw new ToolRegistryError('Prepared tool call was not created by this registry');
    }

    const currentTool = this.tools.get(prepared.name);
    if (currentTool !== preparedTool) {
      this.preparedCalls.delete(preparedObject);
      throw new ToolRegistryError(`Prepared tool call for "${prepared.name}" is stale`);
    }

    return preparedTool.unsafeExecute(prepared.input, ctx);
  }

  /**
   * 兼容无需外部审批的可信调用方。Agent 主链必须显式使用 prepare() →
   * PermissionEngine.gate() → execute()，不能通过此方法跨过审批快照边界。
   */
  async dispatch(
    name: string,
    rawArgs: unknown,
    ctx: ToolExecutionContext,
  ): Promise<unknown> {
    return this.execute(this.prepare(name, rawArgs), ctx);
  }
}
