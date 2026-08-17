// 定义工具作者、注册表与执行器共同遵守的唯一 Tool 契约。
import type { ToolResultContentPart } from '@ema-agent/llm';
import type { PermissionIntent } from '@ema-agent/permission';
import type { z } from 'zod';
import type { ToolInvocation } from './toolInvocation.js';
import type { ToolUseContext } from './toolUseContext.js';

/** 工具实现的可信来源；MCP 身份始终使用 Server 返回的原始名称。 */
export type ToolOrigin =
  | { readonly kind: 'builtin' }
  | {
      readonly kind: 'mcp';
      readonly serverName: string;
      readonly serverToolName: string;
    };

/** validateContext 的校验与投影结果；成功时只交出工具真正需要的能力。 */
export type ToolContextValidation<TContext> =
  | { readonly valid: true; readonly context: TContext }
  | { readonly valid: false; readonly reason: string };

/** Schema 解析后的业务校验结果；失败会在权限询问前返回给模型。 */
export type ToolInputValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly message: string;
      readonly code?: string;
      readonly retryable?: boolean;
    };

/** 工具执行期间产生的增量进度；完成结果仍由 execute 的 Promise 唯一返回。 */
export type ToolProgressCallback<TProgress> = (progress: TProgress) => void;

/**
 * Tool 是工具系统唯一的作者契约和可执行契约。
 *
 * ToolUseContext 是宿主能力全集；具体工具必须通过 validateContext 投影出窄
 * TContext。ToolInvocation 只描述本次调用身份与取消，不承载业务能力。
 */
export interface Tool<TInput, TOutput, TContext, TProgress = never> {
  /** 权限、日志和恢复使用的稳定内部身份，不随模型展示名称变化。 */
  readonly id: string;
  /** 发送给模型并用于匹配 tool_use 的名称。 */
  readonly name: string;
  readonly origin: ToolOrigin;
  /** 写给模型看的用途与使用约束，不承担批准卡片的人话摘要。 */
  readonly description: string;
  /** 根据规范化输入生成批准卡片摘要。 */
  readonly getToolUseSummary?: (input: TInput) => string | undefined;
  /** 所有模型输入必须先通过该 Schema，注册表不会直接执行原始参数。 */
  readonly inputSchema: z.ZodType<TInput, unknown>;
  /** MCP 等已有可信 JSON Schema 的工具可以覆盖 Zod 派生结果。 */
  readonly inputJsonSchemaOverride?: Readonly<Record<string, unknown>>;
  /** 模型可见结果超过该 UTF-8 字节数时由结果层落盘。 */
  readonly maxResultBytes: number;

  /**
   * 同一函数同时承担装配可见性和执行前能力投影。
   * valid:false 时工具不会进入 ToolPool；执行时仍会重新投影，
   * 防止排队期间文件状态等动态能力已经变化。
   */
  readonly validateContext: (context: ToolUseContext) => ToolContextValidation<TContext>;

  /** Schema 只检查结构；路径、文件状态等业务规则在 Permission 之前检查。 */
  readonly validateInput?: (
    input: TInput,
    context: TContext,
    invocation: ToolInvocation,
  ) => ToolInputValidationResult | Promise<ToolInputValidationResult>;

  /** 只描述副作用，供静态调度选择只读并行或有副作用串行。 */
  readonly isReadOnly: (input: TInput) => boolean;
  readonly isConcurrencySafe: (input: TInput) => boolean;
  /** AskUser 等工具会暂停当前 Turn；普通权限审批不属于工具交互。 */
  readonly requiresUserInteraction: (input: TInput) => boolean;

  /** 把已校验调用投影为封口 Permission 包唯一理解的授权意图。 */
  readonly getPermissionIntent: (
    input: TInput,
    context: TContext,
  ) => PermissionIntent | Promise<PermissionIntent>;

  /** 工具只取得窄业务 Context、调用身份和自己的进度出口。 */
  readonly execute: (
    input: TInput,
    context: TContext,
    invocation: ToolInvocation,
    onProgress?: ToolProgressCallback<TProgress>,
  ) => Promise<TOutput>;

  /**
   * 把 TOutput 投影为模型可见内容,执行期调用一次并持久化。
   * 缺省时执行层按"string 原样、其余 JSON 化"处理——简单工具零样板;
   * 复杂工具必须自定义(FileEdit 只报"修改成功"、FileRead 图片给图片块),
   * 不得把 UI/审计专用数据混进模型内容。
   */
  readonly mapResultToModelContent?: (output: TOutput) => string | ToolResultContentPart[];
}

/** 投影成功，携带具体 Tool 真正需要的窄 Context。 */
export const contextOk = <T>(context: T): ToolContextValidation<T> =>
  ({ valid: true, context });

/** 投影失败意味着宿主没有提供该 Tool 必需的业务能力。 */
export const contextFail = <T = never>(reason: string): ToolContextValidation<T> =>
  ({ valid: false, reason });
