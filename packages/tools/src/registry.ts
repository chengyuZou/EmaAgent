import { ZodError } from 'zod';
import type { BuiltTool, ToolDescriptor, ToolExecutionContext } from './types.js';

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
   * Parse, validate, and execute a tool by name.
   *
   * Throws:
   *  - ToolRegistryError — tool not found
   *  - ToolInputError    — input failed Zod validation
   *  - anything thrown by the tool's execute() implementation
   */
  async dispatch(
    name: string,
    rawArgs: unknown,
    ctx: ToolExecutionContext,
  ): Promise<unknown> {
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
    return tool.unsafeExecute(parsed, ctx);
  }
}

// Exported for use in tool-builtin's registerBuiltinTools
export type { AnyBuiltTool };
