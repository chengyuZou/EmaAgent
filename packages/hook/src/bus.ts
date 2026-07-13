import type { TurnId, SessionId, EmaStreamEvent } from '@ema-agent/contracts';
import type { HookEvent, HookPayload } from './events.js';
import { PRIORITY } from './priority.js';

// ── Context 与 Result 类型 ────────────────────────────────────────────────────

export interface HookContext<E extends HookEvent> {
  event: E;
  payload: HookPayload[E];
  turnId: TurnId;
  sessionId: SessionId;
  /**
   * turn 内 handler 间通信的共享可变容器。
   * 单次 trigger() 调用内的所有 handler - 包括并行 handler - 拿到同一个引用。
   * 在 Node.js(单线程事件循环)下并行 handler 的并发写是安全的,
   * 但在 Worker Threads 下不安全。不要在此存 promise 或大对象。
   */
  meta: Record<string, unknown>;
  emit?: (event: EmaStreamEvent) => void;
}

export type HookTriggerContext<E extends HookEvent> =
  Omit<HookContext<E>, 'event'>;

/**
 * 允许 handler 改变控制流的事件。
 *
 * 工具生命周期事件刻意不在此列:工具安全由 PermissionEngine + Sandbox 负责,
 * hook 只是观察/UI 扩展点。
 */
export type ControlHookEvent =
  | 'beforeLlm'
  | 'beforeCompact'
  | 'onTurnStart';

export type ObserverHookEvent = Exclude<HookEvent, ControlHookEvent>;

export type HookControlResult<E extends HookEvent> =
  | { kind: 'continue' }
  | { kind: 'replace'; payload: HookPayload[E] }
  | { kind: 'abort'; reason: string };

export type HookObserverResult = { kind: 'continue' };

/** 单个 hook handler 返回的结果。 */
export type HookResult<E extends HookEvent> =
  E extends ControlHookEvent
    ? HookControlResult<E>
    : HookObserverResult;

type HookRuntimeResult<E extends HookEvent> = HookControlResult<E>;

/** 整条 trigger() 链返回的结果。 */
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

export type HookHandler<E extends HookEvent> = (
  ctx: HookContext<E>,
) => Promise<HookResult<E>> | HookResult<E>;

export interface HookWarning {
  event: HookEvent;
  hook: string;
  reason: string;
}

export interface HookOptions {
  priority?: number;
  name?: string;
  critical?: boolean;
  parallel?: boolean;
  /** 单 handler 超时(ms)。覆盖 bus 级默认值。0 = 不超时。 */
  timeoutMs?: number;
}

export interface HookBusOptions {
  maxConcurrency?:   number;
  parallelEvents?:   ReadonlySet<HookEvent>;
  /**
   * 每次 handler 执行后(成功或出错)调用。
   * 用于结构化日志、telemetry 或测试断言。
   *
   * 生产环境接两路:对慢/出错的 handler 发 `system_warning`,
   * 同时写 ring buffer 供 settings 诊断面板展示近期 hook 活动。
   */
  traceSink?:        (entry: HookTraceEntry) => void;
  /**
   * 为 true 时,注册既没传 `opts.name`、函数本身也无 `.name` 属性的 handler 会打印 console 警告。
   * 默认 false - dev / debug 构建设 true。
   */
  warnAnonymous?:    boolean;
  /**
   * handler 默认超时(ms)。未在此窗口内 resolve 的 handler 视为出错
   * (critical 则 abort,否则 warning)。
   * 0 = 不超时。单 handler `timeoutMs` 覆盖此值。
   * @default 30_000
   */
  handlerTimeoutMs?: number;
}

export interface RegisteredHook {
  event: HookEvent;
  name: string;
  priority: number;
  critical: boolean;
  parallel: boolean;
}

// ── Trace ────────────────────────────────────────────────────────────────────

/** 每次 handler 运行后(成功或出错)由 traceSink 发出。 */
export interface HookTraceEntry {
  event:          HookEvent;
  handlerName:    string;
  durationMs:     number;
  result:         'continue' | 'replace' | 'abort' | 'error';
  /** abort / error 的原因字符串;continue / replace 时缺省。 */
  reason?:        string;
  /** handler 返回 `kind: 'replace'` 时为 true。 */
  payloadReplaced: boolean;
}

// ── 内部注册条目 ───────────────────────────────────────────────

interface HandlerEntry<E extends HookEvent> {
  event: E;
  handler: HookHandler<E>;
  priority: number;
  name: string;
  critical: boolean;
  parallel: boolean;
  timeoutMs: number;
}

type HookBatch<E extends HookEvent> =
  | { kind: 'serial'; entries: HandlerEntry<E>[] }
  | { kind: 'parallel'; entries: HandlerEntry<E>[] };

// ── 默认值 ──────────────────────────────────────────────────────────────────

// 除 beforeToolUse 外的所有 ObserverHookEvent 默认并行。
// beforeToolUse 刻意串行:UI 渲染器需有序投递(先显示"pending"再"running"),
// 审计日志也需保证调用顺序。
const DEFAULT_PARALLEL_EVENTS = new Set<HookEvent>([
  'afterLlmComplete',
  'afterMessage',
  'afterToolUse',
  'onToolFailure',
  'afterCompact',
  'onTurnEnd',
  'onTurnAbort',
]);

const CONTROL_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set<ControlHookEvent>([
  'beforeLlm',
  'beforeCompact',
  'onTurnStart',
]);

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function errorToReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isControlHookEvent(event: HookEvent): event is ControlHookEvent {
  return CONTROL_HOOK_EVENTS.has(event);
}

function observerControlFlowWarning(
  hookName: string,
  result: Exclude<HookRuntimeResult<HookEvent>, HookObserverResult>,
): string {
  if (result.kind === 'abort') {
    return `Observer hook "${hookName}" returned abort (${result.reason}), but observer hooks cannot alter control flow`;
  }
  return `Observer hook "${hookName}" returned replace, but observer hooks cannot alter control flow`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error(`chunk size must be greater than 0, got ${size}`);
  }

  if (size === Number.POSITIVE_INFINITY) {
    return [items];
  }

  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

/** 返回一个在 `ms` 后以超时错误 reject 的 promise。 */
function timeout<T>(ms: number, handlerName: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error(`Hook handler "${handlerName}" timed out after ${ms}ms`)), ms);
  });
}

function buildBatches<E extends HookEvent>(
  entries: HandlerEntry<E>[],
  eventAllowsParallel: boolean,
): HookBatch<E>[] {
  const batches: HookBatch<E>[] = [];

  for (const entry of entries) {
    const canRunParallel = eventAllowsParallel && entry.parallel;
    const last = batches[batches.length - 1];

    if (canRunParallel) {
      if (last?.kind === 'parallel') {
        last.entries.push(entry);
      } else {
        batches.push({
          kind: 'parallel',
          entries: [entry],
        });
      }
    } else {
      batches.push({
        kind: 'serial',
        entries: [entry],
      });
    }
  }

  return batches;
}

// ── HookBus ───────────────────────────────────────────────────────────────────

export class HookBus {
  private readonly registry = new Map<HookEvent, HandlerEntry<HookEvent>[]>();
  private readonly options: HookBusOptions;
  private readonly maxConcurrency: number;
  private readonly parallelEvents: ReadonlySet<HookEvent>;
  private readonly defaultTimeoutMs: number;

  constructor(options: HookBusOptions = {}) {
    this.options          = options;
    this.maxConcurrency   = options.maxConcurrency ?? Number.POSITIVE_INFINITY;
    this.parallelEvents   = options.parallelEvents ?? DEFAULT_PARALLEL_EVENTS;
    this.defaultTimeoutMs = options.handlerTimeoutMs ?? 30_000;

    if (this.maxConcurrency <= 0) {
      throw new Error(
        `maxConcurrency must be greater than 0, got ${this.maxConcurrency}`,
      );
    }
  }

  /**
   * 为某事件注册 handler。
   *
   * @returns 返回一个反注册函数 - 调用它移除该 handler。
   */
  register<E extends HookEvent>(
    event: E,
    handler: HookHandler<E>,
    opts: HookOptions = {},
  ): () => void {
    const entry: HandlerEntry<E> = {
      event,
      handler,
      priority: opts.priority ?? PRIORITY.DEFAULT,
      name: opts.name ?? (handler.name || '<anonymous>'),
      critical: opts.critical ?? true,
      parallel: opts.parallel ?? false,
      timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
    };

    if (this.options.warnAnonymous && entry.name === '<anonymous>') {
      console.warn(`[HookBus] anonymous handler registered for "${event}" - pass opts.name for traceability`);
    }

    if (!this.registry.has(event)) {
      this.registry.set(event, []);
    }

    const list = this.registry.get(event)!;

    list.push(entry as unknown as HandlerEntry<HookEvent>);
    list.sort((a, b) => a.priority - b.priority);

    return () => {
      const idx = list.indexOf(entry as unknown as HandlerEntry<HookEvent>);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    };
  }

  /**
   * 触发某事件的全部 handler。
   *
   * 规则:
   * - handler 按优先级升序执行。
   * - 事件不支持并行时,所有 handler 串行执行。
   * - 事件支持并行时,连续的并行 handler 一起跑,受 maxConcurrency 约束。
   * - 串行 handler 可返回 replace 更新 currentPayload。
   * - 并行 handler 不得返回 replace。
   * - 返回 abort 的 handler 总是中止 trigger 链。
   * - 抛错/reject 只在 hook 为 critical 时才 abort。
   */
  async trigger<E extends HookEvent>(
    event: E,
    ctx: Omit<HookTriggerContext<E>, 'event'>,
  ): Promise<HookTriggerResult<E>> {
    const entries =
      (this.registry.get(event) ?? []) as unknown as HandlerEntry<E>[];

    let currentPayload = ctx.payload as HookPayload[E];
    const warnings: HookWarning[] = [];

    if (entries.length === 0) {
      return {
        kind: 'continue',
        payload: currentPayload,
        warnings,
      };
    }

    const baseCtx: HookContext<E> = {
      ...ctx,
      event,
      payload: currentPayload,
    } as HookContext<E>;

    const eventAllowsParallel = this.parallelEvents.has(event);
    const batches = buildBatches(entries, eventAllowsParallel);

    for (const batch of batches) {
      if (batch.kind === 'serial') {
        for (const entry of batch.entries) {
          const result = await this.runOne(
            event,
            entry,
            baseCtx,
            currentPayload,
            warnings,
          );

          if (!isControlHookEvent(event) && result.kind !== 'continue') {
            warnings.push({
              event,
              hook: entry.name,
              reason: observerControlFlowWarning(entry.name, result),
            });
            continue;
          }

          if (result.kind === 'abort') {
            return {
              kind: 'abort',
              reason: result.reason,
              payload: currentPayload,
              warnings,
            };
          }

          if (result.kind === 'replace') {
            currentPayload = result.payload as HookPayload[E];
          }
        }

        continue;
      }

      const result = await this.runParallelBatch(
        event,
        batch.entries,
        baseCtx,
        currentPayload,
        warnings,
      );

      if (result.kind === 'abort') {
        return {
          kind: 'abort',
          reason: result.reason,
          payload: currentPayload,
          warnings,
        };
      }
    }

    return {
      kind: 'continue',
      payload: currentPayload,
      warnings,
    };
  }

  private async runOne<E extends HookEvent>(
    event: E,
    entry: HandlerEntry<E>,
    baseCtx: HookContext<E>,
    payload: HookPayload[E],
    warnings: HookWarning[],
  ): Promise<HookRuntimeResult<E>> {
    const handlerCtx: HookContext<E> = { ...baseCtx, payload } as HookContext<E>;
    const t0 = performance.now();

    try {
      const promise = entry.handler(handlerCtx) as Promise<HookRuntimeResult<E>>;
      const result  = entry.timeoutMs > 0
        ? await Promise.race([
            promise,
            timeout<HookRuntimeResult<E>>(entry.timeoutMs, entry.name),
          ])
        : await promise;
      try {
        this.options.traceSink?.({
          event:           event,
          handlerName:     entry.name,
          durationMs:      performance.now() - t0,
          result:          result.kind,
          reason:          result.kind === 'abort' ? result.reason : undefined,
          payloadReplaced: result.kind === 'replace',
        });
      } catch { /* 诊断 sink 不得影响 turn 流程 */ }
      return result;
    } catch (err) {
      const reason = errorToReason(err);
      const durationMs = performance.now() - t0;

      try {
        this.options.traceSink?.({
          event:           event,
          handlerName:     entry.name,
          durationMs,
          result:          'error',
          reason,
          payloadReplaced: false,
        });
      } catch { /* 诊断 sink 不得影响 turn 流程 */ }

      if (entry.critical) {
        return {
          kind: 'abort',
          reason,
        };
      }

      warnings.push({
        event,
        hook: entry.name,
        reason,
      });

      return { kind: 'continue' };
    }
  }

  private async runParallelBatch<E extends HookEvent>(
    event: E,
    entries: HandlerEntry<E>[],
    baseCtx: HookContext<E>,
    payload: HookPayload[E],
    warnings: HookWarning[],
  ): Promise<{ kind: 'continue' } | { kind: 'abort'; reason: string }> {
    const chunks = chunkArray(entries, this.maxConcurrency);

    for (const chunk of chunks) {
      const settled = await Promise.allSettled(
        chunk.map((entry) =>
          this.runOne(event, entry, baseCtx, payload, warnings),
        ),
      );

      for (const [i, item] of settled.entries()) {
        const entry = chunk[i]!;

        if (item.status === 'rejected') {
          // runOne 已捕获 handler 错误,这里只是防御性兜底。
          const reason = errorToReason(item.reason);

          if (entry.critical) {
            return {
              kind: 'abort',
              reason,
            };
          }

          warnings.push({
            event,
            hook: entry.name,
            reason,
          });

          continue;
        }

        const result = item.value;

        if (!isControlHookEvent(event) && result.kind !== 'continue') {
          warnings.push({
            event,
            hook: entry.name,
            reason: observerControlFlowWarning(entry.name, result),
          });
          continue;
        }

        if (result.kind === 'abort') {
          return {
            kind: 'abort',
            reason: result.reason,
          };
        }

        if (result.kind === 'replace') {
          // 仅当通过自定义 parallelEvents 配置把 ControlHookEvent 放进并行批次时才可达
          // - 默认配置下不可能。并行批次结构上无法传播 payload 替换,
          // 故视为协议违规。
          const reason = `Parallel hook "${entry.name}" returned replace, but parallel hooks cannot replace payload`;

          if (entry.critical) {
            return {
              kind: 'abort',
              reason,
            };
          }

          warnings.push({
            event,
            hook: entry.name,
            reason,
          });

          continue;
        }

        // continue:无操作
      }
    }

    return { kind: 'continue' };
  }

  /** 列出已注册 hook,可按事件过滤。 */
  list(event?: HookEvent): RegisteredHook[] {
    if (event) {
      return (this.registry.get(event) ?? []).map((entry) => ({
        event,
        name: entry.name,
        priority: entry.priority,
        critical: entry.critical,
        parallel: entry.parallel,
      }));
    }

    const result: RegisteredHook[] = [];

    for (const [evt, entries] of this.registry.entries()) {
      for (const entry of entries) {
        result.push({
          event: evt,
          name: entry.name,
          priority: entry.priority,
          critical: entry.critical,
          parallel: entry.parallel,
        });
      }
    }

    return result.sort((a, b) => a.priority - b.priority);
  }
}
