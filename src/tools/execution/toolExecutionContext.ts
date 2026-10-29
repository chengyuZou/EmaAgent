import type {
  PermissionContext,
  PermissionRequest,
  PermissionUserResponse,
  SessionPermissionApproval,
} from '@ema-agent/permission';
import type { ToolPool } from '../assembly/toolPool.js';
import type { ToolUseContext } from '../interface/toolUseContext.js';
import type { ToolExecutionError } from '../errors.js';
import type { ToolExecutionState } from './toolExecutionState.js';
import type { ToolResultStore } from '../results/toolResultStore.js';

/**
 * Turn 为一次主 Agent 迭代或子代理 Run 装配的工具执行上下文.
 * 执行器读取身份, 权限和保存入口; 具体工具通过 validateContext 取得 ToolUseContext 中的能力.
 */
export type ToolExecutionContext = {
  readonly sessionId: string;
  readonly turnId: string;
  /** 所属 Turn 或子代理 Run 的取消信号. 每个调用另有自己的 signal, 用于只取消该工具. */
  readonly abortSignal: AbortSignal;
  /** 本次执行已经筛选并冻结的工具池. */
  readonly toolPool: ToolPool;
  /** Turn 准备期冻结的权限判定上下文(模式 + 配置规则 + 工作区). */
  readonly permissionContext: PermissionContext;
  /**
   * Turn 通过 SessionInteractionQueue 向用户请求批准, 主 Agent 和子代理共用这条通道.
   * 用户选择 allowSession 时, Turn 先保存会话批准, 再返回回答让执行器继续.
   * 未提供此入口时, Permission 将需要询问的调用判为 deny.
   */
  readonly askPermission?: (
    request: PermissionRequest,
    signal: AbortSignal,
    sessionApproval: SessionPermissionApproval | undefined,
  ) => Promise<PermissionUserResponse>;
  readonly toolContext: ToolUseContext;
  readonly toolResultStore?: ToolResultStore;
  readonly toolExecutionState?: ToolExecutionState;
  /**
   * Turn 为主 Agent 提供的电脑工具登记入口.
   * 执行器在 Schema 解析成功后, 排队等待前调用. 普通工具返回 undefined.
   * 电脑工具按 ToolCallId 记入 ComputerUse, 结束操控时据此取消旧调用.
   * 返回的函数在本次 Tool 处理结束时删除登记; 启动调用未获批准时也释放操控预约.
   */
  readonly registerComputerToolCall?: (
    call: ToolExecutionCall,
    // ComputerUse 用它取消可直接作废的旧调用, 不取消 Turn.
    // 已提交的键鼠动作由 Rust 返回实际结果, 不走这个取消回调.
    cancelPendingComputerCall: (error: ToolExecutionError) => void,
  ) => (() => void) | undefined;
} & (
    | { readonly subagentId?: never; readonly runId?: never }
    | {
      readonly subagentId: string;
      /** 子工具属于本次 Run, turnId 仅保留父调用来源. */
      readonly runId: string;
    }
  );

export interface ToolExecutionCall {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
}

