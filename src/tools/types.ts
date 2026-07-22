// 这里集中定义工具注册、权限检查和执行时共用的基础类型。
import type { z } from 'zod';
import type { SessionId, TurnId, ToolCallId } from '@ema-agent/ids';
import type { IArtifactStore } from '@ema-agent/artifact';
import type {
  AgentKind,
  AskUserQuestionSpec,
  EmaStreamEvent,
} from '@ema-agent/turn';
import type { KbSearchResult } from '@ema-agent/knowledge';
import type { ToolExecutionStatus } from '@ema-agent/storage';
import type {
  AskUserRequiredEvent,
} from '@ema-agent/turn';
import type { ToolPermissionMeta } from '@ema-agent/permission';

// 重新导出,调用方可从任一包 import AgentKind。
export type { AgentKind };

export type { ToolExecutionStatus };

/** 一次工具调用的持久化执行审计记录。 */
export interface ToolExecutionRecord {
  callId: ToolCallId;
  sessionId: SessionId;
  turnId: TurnId;
  toolName: string;
  inputJson: string;
  inputDigest: string;
  status: ToolExecutionStatus;
  resultPreview?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: number;
  completedAt?: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

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

// ── IFileStateStore - 仅接口(由 @ema-agent/agent-context 实现)──────────────
//
// 定义在此，Read/Edit/Write 可调用而无需 import agent-context 包
// (避免 tools -> agent-context -> … 循环)。

export interface IFileStateStoreEntry {
  content:       string;
  mtimeMs:       number;
  offset?:       number;
  limit?:       number;
  isPartialView: boolean;
}

export interface IFileStateStore {
  record(path: string, entry: IFileStateStoreEntry): void;
  get(path: string): (IFileStateStoreEntry & { lastAccessMs: number }) | undefined;
  recentEntries(limit: number): ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
}

// ── ICommandRunner - 仅接口(由 @ema-agent/sandbox 实现)────────────────────

/**
 * 薄接口,tools 可调 sandbox runner 而无需直接 import sandbox 包
 * (避免循环依赖:tools ↛ sandbox ↛ permission)。
 */
export interface RunOptions {
  cwd?:        string;
  timeout?:    number;
  signal?:     AbortSignal;
  /** 即发即弃:detached 拉起,立即返回空结果。 */
  background?: boolean;
}

export interface RunResult {
  stdout:    string;
  stderr:    string;
  exitCode:  number;
  timedOut:  boolean;
  truncated: boolean;
  /** 进程被 per-tool AbortSignal 杀掉(非超时)时为 true。 */
  aborted?:  boolean;
}

export interface ICommandRunner {
  run(command: string, opts?: RunOptions): Promise<RunResult>;
  /** 移除上一条命令植入的 bare-repo 攻击文件。 */
  cleanup(): void;
  /** 权限规则变更后重新推导 sandbox 配置。 */
  refreshConfig(): void;
  /** OS 沙箱降级为应用层时的人类可读原因。 */
  getSandboxUnavailableReason(): string | undefined;
  /**
   * 拆除任何持久 sandbox 资源(如长生命周期 bwrap namespace)。
   * V1 空操作(每命令一进程模型)。预留给 V2 持久 sandbox。
   */
  destroy?(): void;
}

// ── 扩展接口(由 host 注入 ToolExecutionContext)─────────────────────────────

export interface SubagentSpawnOpts {
  model?:       string;
  description?: string;
  /**
   * 上下文构造策略。默认 'fork'。
   * worker 不需要父对话历史、应从干净状态开始时用 'subagent'
   * (省 token,避免上下文串)。
   */
  kind?:        AgentKind;
  /** sub-agent 的预分配 ID - 调用方生成,以便在 spawn 开始前
   *  就能 emit `subagent_started`。 */
  subagentId?:  string;
  /**
   * 本 sub-agent 的 AgentTaskStore task ID。
   * V1 缺失(sub-agent 尚未接入 task journal)。
   * V1.5 由 SubagentSpawner 在 spawn 前调 taskStore.claim() 填入。
   * 贯穿所有 SubagentInnerEvent 成员,以便前端把 detail-stream 事件
   * 关联到其 AgentTask 条目。
   */
  taskId?:      string;
}

export interface ISubagentSpawner {
  /** 同步 spawn - 阻塞父工具槽位直到 sub-agent 完成。 */
  spawn(
    prompt:  string,
    opts:    SubagentSpawnOpts,
    signal:  AbortSignal,
  ): Promise<{ output: string; usage: { inputTokens: number; outputTokens: number } }>;

  /**
   * 后台 spawn - 异步拉起 sub-agent,立即返回其 subagentId。父循环继续;
   * 之后调 awaitBackground() 取结果。
   * sub-agent 必须在父 turn 完成前被 await,避免父 SSE 流关闭后
   * 出现孤儿事件。
   */
  spawnBackground?(
    prompt:  string,
    opts:    SubagentSpawnOpts,
    signal:  AbortSignal,
  ): string;

  /**
   * 阻塞直到后台 sub-agent 完成并返回其输出。
   * sub-agent 失败则抛错。已完成或 subagentId 从未注册时空操作(返回 null)。
   */
  awaitBackground?(
    subagentId: string,
  ): Promise<{ output: string; usage: { inputTokens: number; outputTokens: number } } | null>;

  /**
   * 向运行中的后台 sub-agent 入队一条 coordinator 消息。
   * 消息在 sub-agent 下一次 LLM 迭代开始时注入。
   * sub-agent 仍活跃返 true;已完成返 false。
   */
  queueMessage?(subagentId: string, message: string): boolean;

  /**
   * 取消单个运行中的 sub-agent,不中止父 turn。
   * subagentId 当前非活跃时空操作。
   */
  abortSubagent?(subagentId: string): void;
}

export interface IMcpClientBridge {
  call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Skill Facade 返回给调用工具的结构化激活结果。 */
export interface SkillRunResult {
  /** 替换完参数、准备注入模型上下文的 Skill 正文。 */
  content: string;
  /** Skill 声明的工具名称或稳定工具 ID glob；空数组表示不额外收窄。 */
  allowedToolPatterns: readonly string[];
}

export interface ISkillRunner {
  run(
    skill: string,
    args: string | undefined,
    ctx: ToolExecutionContext,
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
export interface IToolCapabilityScope {
  restrict(restriction: ToolCapabilityRestriction): ToolCapabilitySnapshot;
  snapshot(): ToolCapabilitySnapshot;
}

// ── ToolExecutionContext ───────────────────────────────────────────────────────

export interface ToolExecutionContext {
  sessionId: string;
  turnId: string;
  /** 当前这一次工具调用的唯一编号；直接调用工具的测试或适配器可以不传。 */
  toolCallId?: ToolCallId;
  /** 工作区根。空串 = 无工作区(subagent)。shell 工具用此作 cwd。 */
  workspaceRoot: string;
  /** per-turn 取消信号 - 工具对长操作必须尊重此信号。 */
  signal: AbortSignal;
  /**
   * 当前 turn 内文件读/编辑的共享 mtime 去重缓存。
   * 跨工具调用持久，以便 Edit/Write 校验文件已被完整读取。
   */
  readFileState: ReadFileState;
  /**
   * per-session 持久文件状态存储(AgentFileStateStore)。
   * 跨 turn 存活 - 用于跨 turn 的陈旧编辑检测和压缩后恢复。
   * 测试和非 agent 调用方缺失。
   */
  fileStateStore?: IFileStateStore;
  /**
   * 执行中 emit 一个结构化 SSE 事件(如子步骤的 tool_result)。
   * 可选:并非所有调用方都提供流式通道。
   */
  emit?: (event: EmaStreamEvent) => void;
  /**
   * sandbox 支撑的 shell runner。存在时,bash 工具把执行委托到这里
   * 而非直接 spawn - 免费获得 OS 级沙箱。
   */
  commandRunner?: ICommandRunner;
  /**
   * 工具执行中向用户问一组问题并等答案。
   * 引擎接好 AskUserRegistry 时提供;测试和不支持交互 prompt 的最小嵌入方缺失。
   * `promptId` 必须与已在 `ask_user_required` 广播的 id 一致。
   */
  askUser?: (
    promptId: string,
    questions: AskUserQuestionSpec[],
    request: AskUserRequiredEvent,
  ) => Promise<{ answers: Record<string, string> }>;
  /**
   * 持久 artifact 存储。存在时,artifact_write/read/list 委托到这里
   * 而非进程内内存兜底。
   */
  artifactStore?: IArtifactStore;
  /**
   * sub-agent spawner。AgentEngine 接好 sub-agent 支持时注入。
   * 测试和非 agent 嵌入方缺失。
   */
  subagentSpawner?: ISubagentSpawner;
  /**
   * MCP client 桥。至少一个 MCP server 连上时注入。
   * 未配置 MCP server 时缺失。
   */
  mcpClient?: IMcpClientBridge;
  /**
   * Skill runner。skill registry 接好时注入。
   * 测试和最小嵌入方缺失。
   */
  skillRunner?: ISkillRunner;
  /**
   * 当前 Agent 的工具能力作用域。限制只能做交集收窄；Permission Engine 仍负责
   * 审批每一次具体调用。非 Agent 嵌入方和简单单元测试可以不提供。
   */
  toolCapabilities?: IToolCapabilityScope;
  /**
   * 知识库检索(AgenticRAG)。host adapter 解析绑定的 embedding/rerank 模型,
   * 并把检索限定在 turn 选中的 KB 文档(每个选中文档记一次使用计数)。
   * kbIds:指定 KB([] / 省略 -> 用户选的 KB 或 active KB)。
   * 工具提供 query + topK;LLM 需指定 KB 时可选 kbIds。turn 未配置 KB 时缺失。
   */
  kbSearch?: (query: string, topK?: number, kbIds?: string[]) => Promise<KbSearchResult>;
  /**
   * per-turn scratchpad 目录的绝对路径。
   * 每个 key 存为一个文件;turn 结束时目录删除。
   * 经 spawner 闭包在主 agent 与其所有 sub-agent 间共享。
   * 测试和非 agent 调用方缺失。
   */
  scratchpadDir?: string;
  /**
   * 每次 write 写入 scratchpad 元数据的逻辑作者标签。
   * 主 agent 为 "main";spawn 的 sub-agent 为 "subagent:{shortId}"。
   * 在 scratchpad 上下文注入中展示,以便主 agent 知道每个 key 是谁产的。
   * agent-mode turn 之外缺失。
   */
  scratchpadAuthor?: string;
}

// ── ToolDescriptor - LLM 看到的 ──────────────────────────────────────────────

export interface ToolDescriptor {
  name: string;
  description: string;
  /** 由 Zod input schema 经 zodToJsonSchema() 派生的 JSON Schema。 */
  inputJsonSchema: Record<string, unknown>;
}

/** 一次模型请求可见的单个工具定义，不包含可执行函数。 */
export interface ToolManifestEntry {
  readonly id: string;
  readonly name: string;
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

export interface ToolDef<TInput, TOutput> {
  /** 不随模型展示名称变化的内部身份；权限、日志和恢复逻辑使用它。 */
  id?: string;
  name: string;
  description: string;
  /** 根据本次规范化输入生成批准卡片摘要；与写给模型看的 description 分离。 */
  getToolUseSummary?: (input: TInput) => string | undefined;
  // ZodType<Output, Def, Input> - 我们把 input 侧放宽到 unknown,因为
  // ZodDefault 和 ZodOptional 在 input 侧产出 `T | undefined`,
  // 当 TInput 全部默认值应用时会导致可赋值性失败。
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;

  /** true -> 只读,任何权限模式都可自动放行。 */
  isReadOnly: (input: TInput) => boolean;
  /**
   * true -> 同一 turn 内多个实例可并行。
   * 写共享状态(session store、文件系统)的工具设 false。
   */
  isConcurrencySafe: (input: TInput) => boolean;

  /** PermissionEngine.gate() 查询的权限元数据。 */
  permissionMeta: ToolPermissionMeta;

  execute(input: TInput, ctx: ToolExecutionContext): Promise<TOutput>;
}

// ── BuiltTool - 封闭的、注册表就绪形态 ───────────────────────────────────────

export interface BuiltTool<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly getToolUseSummary?: (input: TInput) => string | undefined;
  readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  readonly isReadOnly: (input: TInput) => boolean;
  readonly isConcurrencySafe: (input: TInput) => boolean;
  readonly permissionMeta: ToolPermissionMeta;
  readonly descriptor: () => ToolDescriptor;
  readonly execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>;
  /**
   * 类型擦除的 execute,供注册表分发 - 调用前 input 必须经 parseInput() 预校验。
   */
  readonly unsafeExecute: (input: unknown, ctx: ToolExecutionContext) => Promise<unknown>;
  /** 解析 + 校验原始 LLM 参数(失败抛 ZodError)。 */
  readonly parseInput: (raw: unknown) => TInput;
}
