// 定义工具作者、注册表与执行器共同遵守的唯一 Tool 契约。
import type { z } from 'zod';
import type { PermissionIntent } from '@ema-agent/permission';

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

// 每个Tool的定义 ────────────────────────────────────────────────

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

  /** 缺少任一宿主能力时，本工具不进入本次模型 Manifest。 */
  requires?: readonly (keyof THostContext)[];

  /**
   * 执行前把宿主 Context 投影成工具自己的窄 Context。
   * 返回 valid:false 时该次调用作为工具错误返回模型（不执行 execute）。
   * 在 prepare 之后、execute 之前调用，因此可拿到 per-tool signal。
   * 例如一个 `FileRead` 工具不需要 `knowledgeSearch` 知识库检索能力因此需要收口
   */
  validateContext(context: THostContext): ToolContextValidation<TToolContext>;

  /** Schema 只检查结构；文件状态、工作区等业务语义在权限询问前由此检查。 */
  validateInput?: (
    input: TInput,
    context: TToolContext,
  ) => ToolInputValidationResult | Promise<ToolInputValidationResult>;

  /** true 只描述副作用，不参与 Permission 裁决。 */
  isReadOnly: (input: TInput) => boolean;
  /**
   * true -> 同一 turn 内多个实例可并行。
   * 写共享状态(session store、文件系统)的工具设 false。
   */
  isConcurrencySafe: (input: TInput) => boolean;
  /** 工具执行期间是否会暂停当前 Turn 等待用户输入。 */
  requiresUserInteraction?: (input: TInput) => boolean;

  /**
   * 业务校验通过后，把本次调用投影为 Permission 可理解的纯数据意图。
   * 硬安全检查仍属于 validateInput，Permission 不执行 Tool 回调。
   */
  getPermissionIntent(
    input: TInput,
    context: TToolContext,
  ): PermissionIntent | Promise<PermissionIntent>;

  execute(
    input: TInput,
    context: TToolContext,
  ): Promise<TOutput>;
}

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

// ── BuiltTool - 封闭的、注册表就Ready形态 ───────────────────────────────────────

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
  readonly getPermissionIntent: (
    input: TInput,
    context: TToolContext,
  ) => Promise<PermissionIntent>;
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
