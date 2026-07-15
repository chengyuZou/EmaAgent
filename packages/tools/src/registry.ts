import { ZodError } from 'zod';
import type { BuiltTool, ToolDescriptor, ToolExecutionContext } from './types.js';
import { freezePreparedInput } from './prepared-call.js';
import type { PreparedToolCall } from './prepared-call.js';

// Registry 是泛型擦除边界；输入在 prepare() 中通过各工具自己的 Schema 恢复类型。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBuiltTool = BuiltTool<any, any>;

/** MCP 注册所有者使用原始名称，不能使用经过清洗的 LLM 可见名称。 */
export interface McpToolOwner {
  readonly serverName: string;
  readonly serverToolName: string;
}

export interface McpToolRegistration {
  readonly tool: AnyBuiltTool;
  readonly owner: McpToolOwner;
}

type ToolOwner = { readonly kind: 'builtin' } | ({ readonly kind: 'mcp' } & McpToolOwner);

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

export class ToolRegistrationConflictError extends ToolRegistryError {
  constructor(
    public readonly toolName: string,
    public readonly existingOwner: ToolOwner,
    public readonly attemptedOwner: ToolOwner,
  ) {
    super(
      `Tool "${toolName}" registration conflict: ` +
      `${describeOwner(existingOwner)} already owns the name; ` +
      `${describeOwner(attemptedOwner)} cannot replace it`,
    );
    this.name = 'ToolRegistrationConflictError';
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
 * Agent 主链固定调用 prepare() → PermissionEngine.gate() → execute()。
 */
export class ToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tools    = new Map<string, BuiltTool<any, any>>();
  /** 与 tools 同键，保存注册来源，确保热更新和注销只能操作自己的工具。 */
  private readonly owners   = new Map<string, ToolOwner>();
  /** 运行时能力表：防止调用方伪造 PreparedToolCall 或跨 Registry 执行。 */
  private readonly preparedCalls = new WeakMap<object, BuiltTool<any, any>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(tool: BuiltTool<any, any>): void {
    if (this.tools.has(tool.name)) {
      throw new ToolRegistryError(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    this.owners.set(tool.name, Object.freeze({ kind: 'builtin' }));
  }

  /**
   * 原子注册一批 MCP 工具。先验证整批所有权，再一次性提交：
   * 同一原始 server/tool 重连可以替换自己；内置工具、其他 Server 及同批
   * 清洗后重名都明确拒绝，不留下半注册状态。
   */
  registerMcpBatch(registrations: readonly McpToolRegistration[]): void {
    const batchOwners = new Map<string, ToolOwner>();
    const validated: Array<{ registration: McpToolRegistration; owner: ToolOwner }> = [];

    for (const registration of registrations) {
      const attemptedOwner = toMcpOwner(registration.owner);
      const duplicateInBatch = batchOwners.get(registration.tool.name);
      if (duplicateInBatch) {
        throw new ToolRegistrationConflictError(
          registration.tool.name,
          duplicateInBatch,
          attemptedOwner,
        );
      }
      batchOwners.set(registration.tool.name, attemptedOwner);

      const existingOwner = this.owners.get(registration.tool.name);
      if (existingOwner && !sameOwner(existingOwner, attemptedOwner)) {
        throw new ToolRegistrationConflictError(
          registration.tool.name,
          existingOwner,
          attemptedOwner,
        );
      }
      validated.push({ registration, owner: attemptedOwner });
    }

    for (const { registration, owner } of validated) {
      this.tools.set(registration.tool.name, registration.tool);
      this.owners.set(registration.tool.name, owner);
    }
  }

  /** 注册单个 MCP 工具；同样遵守 registerMcpBatch() 的所有权规则。 */
  registerMcp(registration: McpToolRegistration): void {
    this.registerMcpBatch([registration]);
  }

  /**
   * 只注销属于指定原始 server/tool 的工具。
   * 返回 false 表示名称不存在或所有者不匹配，绝不会误删其他来源的实现。
   */
  unregisterMcp(name: string, owner: McpToolOwner): boolean {
    const existingOwner = this.owners.get(name);
    if (!existingOwner || !sameOwner(existingOwner, toMcpOwner(owner))) return false;
    this.tools.delete(name);
    this.owners.delete(name);
    return true;
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

function toMcpOwner(owner: McpToolOwner): ToolOwner {
  return Object.freeze({
    kind: 'mcp',
    serverName: owner.serverName,
    serverToolName: owner.serverToolName,
  });
}

function sameOwner(left: ToolOwner, right: ToolOwner): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'builtin' || right.kind === 'builtin') return true;
  return left.serverName === right.serverName && left.serverToolName === right.serverToolName;
}

function describeOwner(owner: ToolOwner): string {
  return owner.kind === 'builtin'
    ? 'builtin tool'
    : `MCP tool "${owner.serverName}/${owner.serverToolName}"`;
}
