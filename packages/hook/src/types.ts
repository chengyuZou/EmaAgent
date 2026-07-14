import type {
  EmaStreamEvent,
  SessionId,
  TurnId,
} from '@ema-agent/contracts';
import type {
  AbortOnlyHookEvent,
  ControlHookEvent,
  HookEvent,
  HookPayload,
} from './events.js';

/** Hook 执行失败的稳定分类，供 trace 和诊断层使用。 */
export type HookFailureKind = 'handler_error' | 'timeout' | 'cancelled';

/** 单个 Hook handler 获得的强类型执行上下文。 */
export interface HookContext<E extends HookEvent> {
  event: E;
  payload: HookPayload[E];
  turnId: TurnId;
  sessionId: SessionId;
  /** 父任务取消或 handler 超时时都会触发。 */
  signal: AbortSignal;
  emit?: (event: EmaStreamEvent) => void;
}

/** 调用 HookBus.trigger() 时提供的上下文。 */
export type HookTriggerContext<E extends HookEvent> =
  Omit<HookContext<E>, 'event' | 'signal'> & {
    /** 父任务取消信号；没有父任务的内部事件可以省略。 */
    signal?: AbortSignal;
  };

export type HookControlResult<E extends HookEvent> =
  | { kind: 'continue' }
  | { kind: 'abort'; reason: string }
  | (E extends AbortOnlyHookEvent
      ? never
      : { kind: 'replace'; payload: HookPayload[E] });

export type HookObserverResult = { kind: 'continue' };

/** 单个 Hook handler 返回的结果。 */
export type HookResult<E extends HookEvent> =
  E extends ControlHookEvent
    ? HookControlResult<E>
    : HookObserverResult;

export type HookHandler<E extends HookEvent> = (
  ctx: HookContext<E>,
) => Promise<HookResult<E>> | HookResult<E>;

export interface HookWarning {
  event: HookEvent;
  hook: string;
  reason: string;
}

/** 整条 trigger() 执行链返回的结果。 */
export type HookTriggerResult<E extends HookEvent> =
  | {
      kind: 'continue';
      payload: HookPayload[E];
      warnings: HookWarning[];
    }
  | {
      kind: 'abort';
      reason: string;
      payload: HookPayload[E];
      warnings: HookWarning[];
    };

export interface HookOptions {
  priority?: number;
  name?: string;
  critical?: boolean;
  parallel?: boolean;
  /** 单 handler 超时(ms)。覆盖 bus 级默认值。0 = 不超时。 */
  timeoutMs?: number;
}

export interface HookBusOptions {
  maxConcurrency?: number;
  parallelEvents?: ReadonlySet<HookEvent>;
  /** 每次 handler 执行后调用，用于结构化日志、诊断或测试断言。 */
  traceSink?: (entry: HookTraceEntry) => void;
  /** 是否在注册匿名 handler 时输出开发期警告。 */
  warnAnonymous?: boolean;
  /** handler 默认超时(ms)，0 表示不超时。@default 30_000 */
  handlerTimeoutMs?: number;
}

export interface RegisteredHook {
  event: HookEvent;
  name: string;
  priority: number;
  critical: boolean;
  parallel: boolean;
}

/** 每次 handler 运行后由 traceSink 发出的结构化记录。 */
export interface HookTraceEntry {
  sessionId: SessionId;
  turnId: TurnId;
  /** 记录完成时的 Unix epoch 毫秒时间，便于导出后跨日志对齐。 */
  timestampMs: number;
  event: HookEvent;
  handlerName: string;
  durationMs: number;
  result: 'continue' | 'replace' | 'abort' | 'error';
  /** abort / error 的原因；continue / replace 时缺省。 */
  reason?: string;
  payloadReplaced: boolean;
  failureKind?: HookFailureKind;
}
