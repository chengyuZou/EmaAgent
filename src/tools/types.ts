// 集中定义工具注册、权限检查和执行时共用的基础类型。
import type { z } from 'zod';
import type {
  AgentRunId,
  SessionId,
  TaskId,
  TurnId,
  ToolCallId,
} from '@ema-agent/ids';
import type { IArtifactStore } from '@ema-agent/artifact';
import type { KbSearchResult } from '@ema-agent/knowledge';
import type { ToolPermissionMeta } from '@ema-agent/permission';
import type { TaskStorePort } from '@ema-agent/tasks';
import type { CommandRunnerPort } from '@ema-agent/sandbox';

/** 子 Agent 启动时如何取得父执行上下文。 */
export type SubagentContextMode = 'subagent' | 'fork';

// ── ReadFileState - turn 内跨工具调用共享的去重缓存 ──────────────────────────

export interface ReadFileEntry {
  /** 读取时的完整文件内容,供编辑防覆盖检查。 */
  content: string;
  /** 读取时的 mtime(毫秒)。 */
  timestamp: number;
  /** 读完整文件(无分页)时为 undefined。 */
  offset?: number;
  limit?: number;
  /** 指定了 offset/limit 时为 true - 编辑必须拒绝基于局部视图的读。 */
  isPartialView: boolean;
}

/** 以绝对规范化路径为键。 */
export type ReadFileState = Map<string, ReadFileEntry>;

// 文件状态由 Tool 模块拥有，读取与编辑工具共享它来阻止陈旧写入。
export interface FileStateStoreEntry {
  content:       string;
  mtimeMs:       number;
  offset?:       number;
  limit?:       number;
  isPartialView: boolean;
}

export interface FileStateStore {
  record(path: string, entry: FileStateStoreEntry): void;
  get(path: string): (FileStateStoreEntry & { lastAccessMs: number }) | undefined;
  recentEntries(limit: number): ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
}

// ── 宿主注入的工具能力端口 ───────────────────────────────────────────────────

export interface SubagentSpawnOpts {
  model?:       string;
  description?: string;
  /**
   * 上下文构造策略。默认 'fork'。
   * worker 不需要父对话历史、应从干净状态开始时用 'subagent'
   * (省 token,避免上下文串)。
   */
  kind?:        SubagentContextMode;
  /** 调用方预分配执行 ID，确保启动事件与持久记录使用同一身份。 */
  agentRunId?: AgentRunId;
  /** 可选关联既有 Task；Spawner 不负责创建或完成 Task。 */
  taskId?: TaskId;
}

export interface SubagentRunResult {
  agentRunId: AgentRunId;
  output: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface SubagentSpawnerPort {
  /** 同步 spawn - 阻塞父工具槽位直到 sub-agent 完成。 */
  spawn(
    prompt:  string,
    opts:    SubagentSpawnOpts,
    signal:  AbortSignal,
  ): Promise<SubagentRunResult>;

  /**
   * spawnBackground 异步拉起子 Agent，立即返回 agentRunId，父循环继续；
   * 之后调 awaitBackground() 取结果。
   * sub-agent 必须在父 turn 完成前被 await,避免父 SSE 流关闭后
   * 出现孤儿事件。
   */
  spawnBackground?(
    prompt:  string,
    opts:    SubagentSpawnOpts,
    signal:  AbortSignal,
  ): AgentRunId;

  /**
   * 阻塞直到后台 sub-agent 完成并返回其输出。
   * 子 Agent 失败时抛错；已经完成或 agentRunId 从未注册时返回 null。
   */
  awaitBackground?(
    agentRunId: AgentRunId,
  ): Promise<SubagentRunResult | null>;

  /**
   * 向运行中的后台 sub-agent 入队一条 coordinator 消息。
   * 消息在 sub-agent 下一次 LLM 迭代开始时注入。
   * sub-agent 仍活跃返 true;已完成返 false。
   */
  queueMessage?(agentRunId: AgentRunId, message: string): boolean;

  /**
   * 取消单个运行中的 sub-agent,不中止父 turn。
   * agentRunId 当前未处于活动状态时不执行操作。
   */
  abortSubagent?(agentRunId: AgentRunId): void;
}

/** Skill Facade 返回给调用工具的结构化激活结果。 */
export interface SkillRunResult {
  /** 替换完参数、准备注入模型上下文的 Skill 正文。 */
  content: string;
  /** Skill 声明的工具名称或稳定工具 ID glob；空数组表示不额外收窄。 */
  allowedToolPatterns: readonly string[];
}

export interface SkillRunnerPort {
  run(
    skill: string,
    args: string | undefined,
  ): Promise<SkillRunResult>;
}

/** 一项只能收窄、不能扩大当前 Agent 工具能力的限制。 */
export interface ToolCapabilityRestriction {
  /** 便于审计和报错的来源，例如 skill:pdf。 */
  source: string;
  /** 对模型可见工具名或稳定内部 ID 进行匹配。 */
  allowedToolPatterns: readonly string[];
}

/** 应用限制后可供模型和执行器共同使用的只读快照。 */
export interface ToolCapabilitySnapshot {
  allowedToolNames: readonly string[];
  restrictionSources: readonly string[];
}

/** Agent 注入工具上下文的能力边界；Skill、运行模式等只能调用 restrict。 */
export interface ToolCapabilityScope {
  restrict(restriction: ToolCapabilityRestriction): ToolCapabilitySnapshot;
  snapshot(): ToolCapabilitySnapshot;
}

/** Tool 侧只关心检索输入输出，KB 绑定与使用计数由宿主完成。 */
export type KnowledgeSearchPort = (
  query: string,
  topK?: number,
  kbIds?: string[],
) => Promise<KbSearchResult>;

// ── 工具调用身份与宿主能力 ───────────────────────────────────────────────────

/** 一次工具调用不可变的运行事实，不承载宿主业务依赖。 */
export interface ToolInvocationContext {
  sessionId: SessionId;
  turnId: TurnId;
  /** 子 Agent 工具调用保留父 turnId，并通过独立身份关联实际执行。 */
  agentRunId?: AgentRunId;
  /** 当前工具调用的唯一编号；权限、审计、取消和文件写入共用该身份。 */
  toolCallId: ToolCallId;
  /** 工作区根。空串 = 无工作区(subagent)。shell 工具用此作 cwd。 */
  workspaceRoot: string;
  /** 单工具取消信号；Turn 取消会由执行器级联到该信号。 */
  signal: AbortSignal;
}
// ── ToolDescriptor - LLM 看到的 ──────────────────────────────────────────────

export interface ToolDescriptor {
  name: string;
  description: string;
  /** 由 Zod input schema 经 zodToJsonSchema() 派生的 JSON Schema。 */
  inputJsonSchema: Record<string, unknown>;
}

/** 工具实现的可信来源
 * 不使用 claude中 `isMcp()`的原因是
 * 避免出现 `isMcp: true` 但 `mcpInfo` 为空的矛盾状态
 */
export type ToolOrigin =
  | { readonly kind: 'builtin' }
  | {
      readonly kind: 'mcp';
      readonly serverName: string;
      readonly serverToolName: string;
    };

/** validateContext 的校验+投影结果：成功时携带收窄后的工具专属 Context。 */
export type ToolContextValidation<TContext> =
  | { readonly valid: true; readonly context: TContext }
  | { readonly valid: false; readonly reason: string };

/** Schema 解析后的业务校验结果；失败会在权限询问前作为工具错误返回模型。 */
export type ToolInputValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly message: string;
      readonly code?: string;
      readonly retryable?: boolean;
    };

/** 一次模型请求可见的单个工具定义，不包含可执行函数。 */
export interface ToolManifestEntry {
  readonly id: string;
  readonly name: string;
  readonly origin: ToolOrigin;
  readonly description: string;
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
}

/** ToolRegistry 在 Turn 开始时生成的不可变能力快照。 */
export interface ToolManifestSnapshot {
  readonly registryVersion: number;
  readonly revision: string;
  readonly entries: readonly ToolManifestEntry[];
}

// ── ToolDef - 作者写的原始定义 ────────────────────────────────────────────────

export interface ToolDef<TInput, TOutput, THostContext, TToolContext> {
  /** 不随模型展示名称变化的内部身份；权限、日志和恢复逻辑使用它。 */
  id?: string;
  name: string;
  /** 省略时按 Ema 内置工具处理；MCP 工具必须声明原始 Server/Tool 身份。 */
  origin?: ToolOrigin;
  description: string;
  /** 根据本次规范化输入生成批准卡片摘要；与写给模型看的 description 分离。 */
  getToolUseSummary?: (input: TInput) => string | undefined;
  // ZodType<Output, Def, Input> - 我们把 input 侧放宽到 unknown,因为
  // ZodDefault 和 ZodOptional 在 input 侧产出 `T | undefined`,
  // 当 TInput 全部默认值应用时会导致可赋值性失败。
  /** 运行时解析并校验模型提交的原始参数；所有工具都必须提供。 */
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  /**
   * 覆盖最终发送给模型的输入 JSON Schema。MCP 使用 Server 的原始 Schema；
   * 省略时由 buildTool() 从 inputSchema 自动生成。
   */
  inputJsonSchemaOverride?: Record<string, unknown>;

  /** 模型可见结果超过该 UTF-8 字节数时落盘；Infinity 表示工具自行封顶且禁止外置。 */
  maxResultBytes?: number;

  /**
   * 装配可见性：声明依赖的宿主能力键，缺一则该工具不进入 ToolPool（模型看不到）。
   * 无状态工具省略。这是"无能力不进 Pool"的静态声明；
   * 运行时的 Context 投影由 validateContext 完成。
   */
  requires?: readonly (keyof THostContext)[];

  /**
   * 执行前把宿主 Context 投影成工具自己的窄 Context。
   * 返回 valid:false 时该次调用作为工具错误返回模型（不执行 execute）。
   * 在 prepare 之后、execute 之前调用，因此可拿到 per-tool signal。
   */
  validateContext(context: THostContext): ToolContextValidation<TToolContext>;

  /** Schema 只检查结构；文件状态、工作区等业务语义在权限询问前由此检查。 */
  validateInput?: (
    input: TInput,
    context: TToolContext,
  ) => ToolInputValidationResult | Promise<ToolInputValidationResult>;

  /** true -> 只读,任何权限模式都可自动放行。 */
  isReadOnly: (input: TInput) => boolean;
  /**
   * true -> 同一 turn 内多个实例可并行。
   * 写共享状态(session store、文件系统)的工具设 false。
   */
  isConcurrencySafe: (input: TInput) => boolean;
  /** 工具执行期间是否会暂停当前 Turn 等待用户输入。 */
  requiresUserInteraction?: (input: TInput) => boolean;

  /** PermissionEngine.gate() 查询的权限元数据。 */
  permissionMeta: ToolPermissionMeta;

  execute(
    input: TInput,
    context: TToolContext,
  ): Promise<TOutput>;
}

// ── BuiltTool - 封闭的、注册表就绪形态 ───────────────────────────────────────

export interface BuiltTool<TInput = unknown, TOutput = unknown, TToolContext = unknown> {
  readonly id: string;
  readonly name: string;
  readonly origin: ToolOrigin;
  readonly description: string;
  readonly getToolUseSummary?: (input: TInput) => string | undefined;
  /** 运行时解析与校验使用的 Zod Schema。 */
  readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  /** 构建时提供的模型 JSON Schema 覆盖值；最终 Schema 从 descriptor() 获取。 */
  readonly inputJsonSchemaOverride?: Readonly<Record<string, unknown>>;
  readonly maxResultBytes: number;
  /** 装配可见性声明（宿主能力键名）；见 ToolDef.requires。类型擦除后为 string[]。 */
  readonly requires?: readonly string[];
  readonly validateInput?: (
    input: TInput,
    context: TToolContext,
  ) => ToolInputValidationResult | Promise<ToolInputValidationResult>;
  readonly isReadOnly: (input: TInput) => boolean;
  readonly isConcurrencySafe: (input: TInput) => boolean;
  readonly requiresUserInteraction: (input: TInput) => boolean;
  readonly permissionMeta: ToolPermissionMeta;
  readonly descriptor: () => ToolDescriptor;
  readonly execute: (
    input: TInput,
    context: TToolContext,
  ) => Promise<TOutput>;
  /**
   * 类型擦除的 execute,供注册表分发 - 调用前 input 必须经 parseInput() 预校验,
   * context 必须经 unsafeValidateContext() 投影为工具自己的窄 Context。
   */
  readonly unsafeExecute: (
    input: unknown,
    context: unknown,
  ) => Promise<unknown>;
  /**
   * 类型擦除的 validateContext,供注册表/执行器在类型擦除边界投影宿主 Context。
   * 内部把 unknown 断言为工具定义的 THostContext 后调用作者写的 validateContext。
   */
  readonly unsafeValidateContext: (context: unknown) => ToolContextValidation<TToolContext>;
  /** 解析 + 校验原始 LLM 参数(失败抛 ZodError)。 */
  readonly parseInput: (raw: unknown) => TInput;
}
