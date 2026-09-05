// 集中定义 src/tools 模块的错误类、错误码与取消错误构造助手。
import { ZodError } from 'zod';
import type { ToolOrigin } from './Tool/tool.js';
import type { ToolExecutionStatus } from './execution/toolExecutionState.js';

// ── 工具注册与输入准备 ───────────────────────────────────────────────────────

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

export class ToolRegistrationConflictError extends ToolRegistryError {
  constructor(
    public readonly toolName: string,
    public readonly existingOrigin: ToolOrigin,
    public readonly attemptedOrigin: ToolOrigin,
  ) {
    super(
      `Tool "${toolName}" registration conflict: ` +
      `${describeOrigin(existingOrigin)} already provides the name; ` +
      `${describeOrigin(attemptedOrigin)} cannot replace it`,
    );
    this.name = 'ToolRegistrationConflictError';
  }
}

function describeOrigin(origin: ToolOrigin): string {
  return origin.kind === 'builtin'
    ? 'builtin tool'
    : `MCP tool "${origin.serverName}/${origin.serverToolName}"`;
}

/** 模型提交的工具参数无法通过该工具的输入 Schema 解析。 */
export class ToolInputError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly zodError: ZodError,
  ) {
    super(`Invalid input for tool "${toolName}": ${zodError.message}`);
    this.name = 'ToolInputError';
  }
}

// ── 工具执行状态 ─────────────────────────────────────────────────────────────

/** 工具执行状态机发生非法迁移（CAS 冲突或调用不存在）。 */
export class ToolExecutionStateConflictError extends Error {
  constructor(
    readonly callId: string,
    readonly expected: readonly ToolExecutionStatus[],
    readonly actual?: ToolExecutionStatus,
  ) {
    super(
      actual
        ? `工具调用 ${callId} 状态冲突：期望 ${expected.join('/')}，实际 ${actual}`
        : `工具调用 ${callId} 不存在`,
    );
    this.name = 'ToolExecutionStateConflictError';
  }
}

// ── 工具定义装配 ─────────────────────────────────────────────────────────────

/** buildTool() 收到的 Tool 声明不满足运行时不变量。 */
export class ToolDefinitionError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'ToolDefinitionError';
  }
}

// ── Tool Result 存储 ─────────────────────────────────────────────────────────

/** ToolResultStore 收到非法参数。 */
export class ToolResultStoreError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'ToolResultStoreError';
  }
}

// ── 后台进程 ─────────────────────────────────────────────────────────────────

export type BackgroundProcessErrorCode =
  | 'shutting_down'
  | 'starts_closed'
  | 'stopped_before_start'
  | 'state_changed_before_stop'
  | 'not_attached'
  | 'session_deleted'
  | 'app_shutting_down'
  | 'not_found'
  | 'invalid_cursor'
  | 'cancelled_before_start';

/** 后台进程运行时的状态与归属错误；message 保持稳定供终止原因与路由诊断使用。 */
export class BackgroundProcessError extends Error {
  constructor(
    readonly code: BackgroundProcessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BackgroundProcessError';
  }
}

/** 命令在真正启动前被取消；保持 name=AbortError 供统一取消判断识别。 */
export function createBackgroundProcessAbortError(): Error {
  return Object.assign(
    new Error('Command cancelled before start'),
    { name: 'AbortError' },
  );
}
