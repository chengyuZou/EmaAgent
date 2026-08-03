// 注册、查找和准备内置及 MCP 工具，并阻止名称或身份冲突。
import { ZodError } from 'zod';
import {
  ToolInputError,
  ToolRegistrationConflictError,
  ToolRegistryError,
} from './errors.js';
import type {
  BuiltTool,
  ToolContextValidation,
  ToolDescriptor,
  ToolInputValidationResult,
  ToolManifestSnapshot,
  ToolOrigin,
} from './types.js';
import { freezePreparedInput } from './prepared-call.js';
import type { PreparedToolCall } from './prepared-call.js';
import { createToolManifestSnapshot } from './toolManifest.js';

// Registry 是泛型擦除边界；输入在 prepare() 中通过各工具自己的 Schema 恢复类型。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBuiltTool = BuiltTool<any, any, any>;

/** MCP 注册所有者使用原始名称，不能使用经过清洗的 LLM 可见名称。 */
export interface McpToolOwner {
  readonly serverName: string;
  readonly serverToolName: string;
}

export interface McpToolRegistration {
  readonly tool: AnyBuiltTool;
  readonly owner: McpToolOwner;
}

type ToolOwner = ToolOrigin;

/**
 * Central registry for all BuiltTool instances.
 *
 * Builtin 在启动时注册；MCP 在连接与重连时只更新自己拥有的动态分区。
 * Agent 主链固定调用 prepare() → PermissionEngine.gate() → execute()。
 */
export class ToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tools    = new Map<string, BuiltTool<any, any, any>>();
  /** 内部稳定身份不能被另一个工具重复占用。 */
  private readonly toolsById = new Map<string, BuiltTool<any, any, any>>();
  /** 与 tools 同键，保存注册来源，确保热更新和注销只能操作自己的工具。 */
  private readonly owners   = new Map<string, ToolOwner>();
  /** 运行时能力表：防止调用方伪造 PreparedToolCall 或跨 Registry 执行。 */
  private readonly preparedCalls = new WeakMap<object, BuiltTool<any, any, any>>();
  /** Manifest provenance 只保存在 Registry 内，外部复制相同字段也不能用于执行。 */
  private readonly manifestTools = new WeakMap<object, ReadonlyMap<string, AnyBuiltTool>>();
  private manifestVersion = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(tool: BuiltTool<any, any, any>): void {
    if (tool.origin.kind !== 'builtin') {
      throw new ToolRegistryError(`MCP tool "${tool.name}" must use registerMcp()`);
    }
    if (this.tools.has(tool.name)) {
      throw new ToolRegistryError(`Tool "${tool.name}" is already registered`);
    }
    if (this.toolsById.has(tool.id)) {
      throw new ToolRegistryError(`Tool id "${tool.id}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    this.toolsById.set(tool.id, tool);
    this.owners.set(tool.name, Object.freeze({ kind: 'builtin' }));
    this.manifestVersion += 1;
  }

  /**
   * 原子注册一批 MCP 工具。先验证整批所有权，再一次性提交：
   * 同一原始 server/tool 重连可以替换自己；内置工具、其他 Server 及同批
   * 清洗后重名都明确拒绝，不留下半注册状态。
   */
  registerMcpBatch(registrations: readonly McpToolRegistration[]): void {
    const batchOwners = new Map<string, ToolOwner>();
    const batchIds = new Map<string, string>();
    const validated: Array<{ registration: McpToolRegistration; owner: ToolOwner }> = [];

    for (const registration of registrations) {
      const attemptedOwner = toMcpOwner(registration.owner);
      if (!sameOwner(registration.tool.origin, attemptedOwner)) {
        throw new ToolRegistryError(
          `MCP tool "${registration.tool.name}" origin does not match its registration owner`,
        );
      }
      const duplicateInBatch = batchOwners.get(registration.tool.name);
      if (duplicateInBatch) {
        throw new ToolRegistrationConflictError(
          registration.tool.name,
          duplicateInBatch,
          attemptedOwner,
        );
      }
      batchOwners.set(registration.tool.name, attemptedOwner);

      const duplicateIdName = batchIds.get(registration.tool.id);
      if (duplicateIdName && duplicateIdName !== registration.tool.name) {
        throw new ToolRegistryError(
          `Tool id "${registration.tool.id}" is shared by "${duplicateIdName}" and "${registration.tool.name}"`,
        );
      }
      batchIds.set(registration.tool.id, registration.tool.name);

      const existingOwner = this.owners.get(registration.tool.name);
      if (existingOwner && !sameOwner(existingOwner, attemptedOwner)) {
        throw new ToolRegistrationConflictError(
          registration.tool.name,
          existingOwner,
          attemptedOwner,
        );
      }
      const existingById = this.toolsById.get(registration.tool.id);
      if (existingById && existingById.name !== registration.tool.name) {
        throw new ToolRegistryError(`Tool id "${registration.tool.id}" is already registered`);
      }
      validated.push({ registration, owner: attemptedOwner });
    }

    for (const { registration, owner } of validated) {
      const previous = this.tools.get(registration.tool.name);
      if (previous && previous.id !== registration.tool.id) this.toolsById.delete(previous.id);
      this.tools.set(registration.tool.name, registration.tool);
      this.toolsById.set(registration.tool.id, registration.tool);
      this.owners.set(registration.tool.name, owner);
    }
    if (validated.length > 0) this.manifestVersion += 1;
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
    const tool = this.tools.get(name);
    this.tools.delete(name);
    if (tool) this.toolsById.delete(tool.id);
    this.owners.delete(name);
    this.manifestVersion += 1;
    return true;
  }

  /** 工具未注册时抛 ToolRegistryError。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): BuiltTool<any, any, any> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolRegistryError(`Tool "${name}" is not registered`);
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  list(): BuiltTool<any, any, any>[] {
    return [...this.tools.values()];
  }

  descriptors(): ToolDescriptor[] {
    return this.list().map((t) => t.descriptor());
  }

  /**
   * 固化一次 Turn 实际可见的工具。selection 必须来自当前 Registry，不能注入
   * 同名伪造实现；MCP 热更新后旧 Manifest 会在 prepare() 阶段明确失效。
   */
  manifestSnapshot(selection: readonly AnyBuiltTool[] = this.list()): ToolManifestSnapshot {
    const selected = new Map<string, AnyBuiltTool>();
    for (const tool of selection) {
      if (this.tools.get(tool.name) !== tool) {
        throw new ToolRegistryError(`Tool "${tool.name}" does not belong to the current registry`);
      }
      if (selected.has(tool.name)) {
        throw new ToolRegistryError(`Tool "${tool.name}" appears more than once in the manifest`);
      }
      selected.set(tool.name, tool);
    }

    const snapshot = createToolManifestSnapshot([...selected.values()], this.manifestVersion);
    this.manifestTools.set(snapshot, selected);
    return snapshot;
  }

  /**
   * 查找工具并完成一次且仅一次的输入解析。
   * 返回值同时供 Hook、PermissionEngine 和 execute() 使用。
   */
  prepare(
    name: string,
    rawArgs: unknown,
    manifest?: ToolManifestSnapshot,
  ): PreparedToolCall {
    const tool = manifest ? this.toolFromManifest(manifest, name) : this.get(name);
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
      id: tool.id,
      name,
      origin: tool.origin,
      summary: tool.getToolUseSummary?.(input),
      input,
      permissionMeta,
      isReadOnly: tool.isReadOnly(input),
      isConcurrencySafe: tool.isConcurrencySafe(input),
      requiresUserInteraction: tool.requiresUserInteraction(input),
      maxResultBytes: tool.maxResultBytes,
    }) satisfies PreparedToolCall;

    this.preparedCalls.set(prepared, tool);
    return prepared;
  }

  /**
   * 把宿主 Context 投影成工具自己的窄 Context。
   * 执行器在 prepare 之后、execute 之前调用;返回 valid:false 时该次调用
   * 作为工具错误返回模型(不执行 execute)。
   */
  validateContext(
    prepared: PreparedToolCall,
    hostContext: unknown,
  ): ToolContextValidation<unknown> {
    return this.preparedTool(prepared).unsafeValidateContext(hostContext);
  }

  /** 对已经冻结的输入执行 Schema 之后、权限之前的业务语义校验。 */
  async validate(
    prepared: PreparedToolCall,
    narrowedContext: unknown,
  ): Promise<ToolInputValidationResult> {
    const tool = this.preparedTool(prepared);
    // 注册表是类型擦除边界;窄 Context 由 validateContext 投影后以 unknown 传入。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await tool.validateInput?.(prepared.input, narrowedContext as any) ?? { valid: true };
  }

  private toolFromManifest(manifest: ToolManifestSnapshot, name: string): AnyBuiltTool {
    const snapshotTools = this.manifestTools.get(manifest);
    if (!snapshotTools) {
      throw new ToolRegistryError('Tool manifest was not created by this registry');
    }
    const tool = snapshotTools.get(name);
    if (!tool) {
      throw new ToolRegistryError(`Tool "${name}" is not present in the approved manifest`);
    }
    if (this.tools.get(name) !== tool) {
      throw new ToolRegistryError(`Tool manifest for "${name}" is stale`);
    }
    return tool;
  }

  /**
   * 执行由本 Registry 准备的不可变调用。
   * MCP 热更新等注册表变化会让旧快照失效，避免审批旧实现却执行新实现。
   */
  async execute(
    prepared: PreparedToolCall,
    narrowedContext: unknown,
  ): Promise<unknown> {
    return this.preparedTool(prepared).unsafeExecute(prepared.input, narrowedContext);
  }

  private preparedTool(prepared: PreparedToolCall): AnyBuiltTool {
    const preparedObject = prepared as object;
    const tool = this.preparedCalls.get(preparedObject);
    if (!tool) {
      throw new ToolRegistryError('Prepared tool call was not created by this registry');
    }
    if (this.tools.get(prepared.name) !== tool) {
      this.preparedCalls.delete(preparedObject);
      throw new ToolRegistryError(`Prepared tool call for "${prepared.name}" is stale`);
    }
    return tool;
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
