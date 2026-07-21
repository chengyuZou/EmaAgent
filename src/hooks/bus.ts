import { randomUUID } from 'node:crypto';
import { asHookInvocationId } from '@ema-agent/contracts';
import type {
  ControlHookEvent,
  HookEvent,
  HookPayload,
} from './events.js';
import { PRIORITY } from './priority.js';
import {
  classifyHookFailure,
  HookCancelledError,
  HookConfigurationError,
  HookTimeoutError,
} from './errors.js';
import { cloneHookPayload, immutableHookPayload } from './payload-snapshot.js';
import type {
  HookBusOptions,
  HookContext,
  HookControlResult,
  HookHandler,
  HookOptions,
  HookTriggerContext,
  HookTriggerResult,
  HookWarning,
  RegisteredHook,
} from './types.js';

type ReportableHookFailureKind = 'handler_error' | 'timeout' | 'protocol_violation';

type HookRuntimeResult<E extends HookEvent> =
  | HookControlResult<E>
  | { kind: 'cancelled'; reason: string };

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
  'afterAssistantMessage',
  'afterToolUse',
  'onToolFailure',
  'afterCompact',
  'onTurnEnd',
  'onTurnAbort',
  'onTurnFailure',
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
  result: Extract<HookRuntimeResult<HookEvent>, { kind: 'abort' | 'replace' }>,
): string {
  if (result.kind === 'abort') {
    return `Observer hook "${hookName}" returned abort (${result.reason}), but observer hooks cannot alter control flow`;
  }
  return `Observer hook "${hookName}" returned replace, but observer hooks cannot alter control flow`;
}

function emitHookWarning<E extends HookEvent>(
  ctx: HookContext<E>,
  input: {
    handlerName: string;
    severity: 'warn' | 'error';
    failureKind: ReportableHookFailureKind;
    message: string;
    durationMs?: number;
  },
): void {
  try {
    ctx.emit?.({
      type: 'hook_warning',
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      hookInvocationId: ctx.invocationId,
      hookEvent: ctx.event,
      handlerName: input.handlerName,
      severity: input.severity,
      failureKind: input.failureKind,
      message: input.message,
      timestampMs: Date.now(),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    });
  } catch {
    // SSE 诊断是旁路能力，消费者异常不得反向破坏 Turn 主流程。
  }
}

function appendWarning<E extends HookEvent>(
  warnings: HookWarning[],
  ctx: HookContext<E>,
  handlerName: string,
  reason: string,
  failureKind: ReportableHookFailureKind,
  durationMs?: number,
): void {
  warnings.push({
    invocationId: ctx.invocationId,
    event: ctx.event,
    hook: handlerName,
    reason,
  });
  emitHookWarning(ctx, {
    handlerName,
    severity: failureKind === 'protocol_violation' ? 'warn' : 'error',
    failureKind,
    message: reason,
    durationMs,
  });
}

const DEFAULT_MAX_CONCURRENCY = 8;
const MAX_TIMER_MS = 2_147_483_647;

interface HandlerAbortScope {
  signal: AbortSignal;
  interruption: Promise<never>;
  cleanup(): void;
}

function validateTimeoutMs(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_MS) {
    throw new HookConfigurationError(
      `${label} must be an integer between 0 and ${MAX_TIMER_MS}, got ${value}`,
    );
  }
}

function createHandlerAbortScope(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  handlerName: string,
): HandlerAbortScope {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectInterruption!: (reason: Error) => void;

  const interruption = new Promise<never>((_, reject) => {
    rejectInterruption = reject;
  });

  const abort = (reason: Error): void => {
    if (controller.signal.aborted) return;
    // 先让执行竞速确定为中断，再广播 signal。否则同步 abort 监听器若立即
    // resolve handler，可能抢在 interruption 前被 Promise.race 选中。
    rejectInterruption(reason);
    controller.abort(reason);
  };

  const onParentAbort = (): void => {
    const reason = parentSignal?.reason === undefined
      ? 'Hook execution cancelled by parent task'
      : `Hook execution cancelled by parent task: ${errorToReason(parentSignal.reason)}`;
    abort(new HookCancelledError(reason));
  };

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  }

  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      abort(new HookTimeoutError(handlerName, timeoutMs));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    interruption,
    cleanup(): void {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
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
    this.maxConcurrency   = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.parallelEvents   = options.parallelEvents ?? DEFAULT_PARALLEL_EVENTS;
    this.defaultTimeoutMs = options.handlerTimeoutMs ?? 30_000;

    if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency <= 0) {
      throw new HookConfigurationError(
        `maxConcurrency must be a positive safe integer, got ${this.maxConcurrency}`,
      );
    }
    validateTimeoutMs(this.defaultTimeoutMs, 'handlerTimeoutMs');
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
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    validateTimeoutMs(timeoutMs, 'HookOptions.timeoutMs');

    const entry: HandlerEntry<E> = {
      event,
      handler,
      priority: opts.priority ?? PRIORITY.DEFAULT,
      name: opts.name ?? (handler.name || '<anonymous>'),
      critical: opts.critical ?? true,
      parallel: opts.parallel ?? false,
      timeoutMs,
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
    ctx: HookTriggerContext<E>,
  ): Promise<HookTriggerResult<E>> {
    const invocationId = asHookInvocationId(randomUUID());
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
      invocationId,
      payload: currentPayload,
      signal: ctx.signal ?? new AbortController().signal,
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

          if (result.kind === 'cancelled') {
            return {
              kind: 'abort',
              reason: result.reason,
              payload: currentPayload,
              warnings,
            };
          }

          if (!isControlHookEvent(event) && result.kind !== 'continue') {
            appendWarning(
              warnings,
              baseCtx,
              entry.name,
              observerControlFlowWarning(entry.name, result),
              'protocol_violation',
            );
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
            // replace 可能复用了只读输入中的嵌套对象；恢复为独立、未冻结的业务 Payload。
            currentPayload = cloneHookPayload(result.payload as HookPayload[E]);
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
    const scope = createHandlerAbortScope(baseCtx.signal, entry.timeoutMs, entry.name);
    const handlerCtx: HookContext<E> = {
      ...baseCtx,
      payload: immutableHookPayload(payload),
      signal: scope.signal,
    } as HookContext<E>;
    const t0 = performance.now();

    try {
      const result = scope.signal.aborted
        ? await scope.interruption
        : await Promise.race([
            Promise.resolve().then(() => entry.handler(handlerCtx)),
            scope.interruption,
          ]);
      try {
        this.options.traceSink?.({
          invocationId:    baseCtx.invocationId,
          sessionId:       baseCtx.sessionId,
          turnId:          baseCtx.turnId,
          timestampMs:     Date.now(),
          event:           event,
          handlerName:     entry.name,
          durationMs:      performance.now() - t0,
          result:          result.kind,
          reason:          result.kind === 'abort' ? result.reason : undefined,
          payloadReplaced: result.kind === 'replace',
        });
      } catch { /* 诊断 sink 不得影响 turn 流程 */ }
      // TypeScript 无法在条件泛型 HookResult<E> 上保持 payload 与 E 的关联；
      // handlerCtx 与 entry 已由同一个 E 构造，此处只恢复该关联，不改变运行时值。
      return result as HookRuntimeResult<E>;
    } catch (err) {
      const reason = errorToReason(err);
      const durationMs = performance.now() - t0;
      const failureKind = classifyHookFailure(err);

      try {
        this.options.traceSink?.({
          invocationId:    baseCtx.invocationId,
          sessionId:       baseCtx.sessionId,
          turnId:          baseCtx.turnId,
          timestampMs:     Date.now(),
          event:           event,
          handlerName:     entry.name,
          durationMs,
          result:          'error',
          reason,
          payloadReplaced: false,
          failureKind,
        });
      } catch { /* 诊断 sink 不得影响 turn 流程 */ }

      if (err instanceof HookCancelledError) {
        return { kind: 'cancelled', reason };
      }

      const reportableFailureKind: ReportableHookFailureKind =
        failureKind === 'timeout' ? 'timeout' : 'handler_error';

      if (entry.critical) {
        emitHookWarning(baseCtx, {
          handlerName: entry.name,
          severity: 'error',
          failureKind: reportableFailureKind,
          message: reason,
          durationMs,
        });
        return {
          kind: 'abort',
          reason,
        };
      }

      appendWarning(
        warnings,
        baseCtx,
        entry.name,
        reason,
        reportableFailureKind,
        durationMs,
      );

      return { kind: 'continue' };
    } finally {
      scope.cleanup();
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

          appendWarning(
            warnings,
            baseCtx,
            entry.name,
            reason,
            'handler_error',
          );

          continue;
        }

        const result = item.value;

        if (result.kind === 'cancelled') {
          return {
            kind: 'abort',
            reason: result.reason,
          };
        }

        if (!isControlHookEvent(event) && result.kind !== 'continue') {
          appendWarning(
            warnings,
            baseCtx,
            entry.name,
            observerControlFlowWarning(entry.name, result),
            'protocol_violation',
          );
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

          appendWarning(
            warnings,
            baseCtx,
            entry.name,
            reason,
            'protocol_violation',
          );

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
