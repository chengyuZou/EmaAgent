// 管理流式请求的熔断、首包前重试、取消传播和 done 终态校验。
import {
  CircuitOpenError,
  isAbortError,
  LlmStreamProtocolError,
  throwAbortReason,
} from './errors.js';
import { isRetryable, sleep } from './retry.js';
import type { LlmStreamChunk } from './types.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_FAILURE_WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 30_000;

type CircuitState =
  | {
      phase: 'closed';
      failures: number;
      firstFailureAt: number;
      generation: number;
    }
  | { phase: 'open'; since: number; generation: number }
  | { phase: 'half-open'; probeId: symbol | null; generation: number };

export interface CircuitPermit {
  readonly mode: 'closed' | 'probe';
  readonly requestId: symbol;
  readonly generation: number;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  failureWindowMs?: number;
  cooldownMs?: number;
}

/** 单个 Provider 的并发安全熔断状态机。 */
export class CircuitBreaker {
  private state: CircuitState = {
    phase: 'closed',
    failures: 0,
    firstFailureAt: 0,
    generation: 0,
  };

  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly cooldownMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.failureWindowMs = options.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

    this.assertPositiveInteger('failureThreshold', this.failureThreshold);
    this.assertNonNegativeInteger('failureWindowMs', this.failureWindowMs);
    this.assertNonNegativeInteger('cooldownMs', this.cooldownMs);
  }

  /**
   * 为一次流调用申请许可。
   *
   * half-open 只发放一个探针许可；后续并发调用在探针给出结论前同步拒绝。
   * generation 用于阻止旧请求的迟到结果覆盖较新的 open/half-open 状态。
   */
  guard(now = Date.now()): CircuitPermit {
    if (
      this.state.phase === 'closed'
      && this.state.failures > 0
      && now - this.state.firstFailureAt > this.failureWindowMs
    ) {
      this.state = {
        phase: 'closed',
        failures: 0,
        firstFailureAt: 0,
        generation: this.state.generation + 1,
      };
    }

    if (this.state.phase === 'closed') {
      return {
        mode: 'closed',
        requestId: Symbol('llm-circuit-request'),
        generation: this.state.generation,
      };
    }

    if (this.state.phase === 'open') {
      if (now - this.state.since < this.cooldownMs) {
        throw this.openError(this.state.since);
      }

      const probeId = Symbol('llm-circuit-probe');
      const generation = this.state.generation + 1;
      this.state = { phase: 'half-open', probeId, generation };
      return { mode: 'probe', requestId: probeId, generation };
    }

    if (this.state.probeId !== null) {
      throw this.openError(now);
    }

    const probeId = Symbol('llm-circuit-probe');
    this.state = { ...this.state, probeId };
    return {
      mode: 'probe',
      requestId: probeId,
      generation: this.state.generation,
    };
  }

  /** 仅收到合法 done 时提交成功；旧请求的迟到成功不会误关新熔断周期。 */
  success(permit: CircuitPermit): void {
    if (!this.matches(permit)) return;

    const generation = this.state.phase === 'half-open'
      ? this.state.generation + 1
      : this.state.generation;
    this.state = {
      phase: 'closed',
      failures: 0,
      firstFailureAt: 0,
      generation,
    };
  }

  /** 仅 Provider 可重试错误或流协议错误进入失败统计。 */
  failure(permit: CircuitPermit, now = Date.now()): void {
    if (!this.matches(permit)) return;

    if (this.state.phase === 'half-open') {
      this.state = {
        phase: 'open',
        since: now,
        generation: this.state.generation + 1,
      };
      return;
    }

    // matches() 已排除 open；显式守卫让判别联合在当前方法内完成收窄。
    if (this.state.phase !== 'closed') return;

    const failures = this.state.failures + 1;
    const firstFailureAt = this.state.failures === 0
      ? now
      : this.state.firstFailureAt;

    if (failures >= this.failureThreshold) {
      this.state = {
        phase: 'open',
        since: now,
        generation: this.state.generation + 1,
      };
      return;
    }

    this.state = { ...this.state, failures, firstFailureAt };
  }

  /**
   * 释放没有产生 Provider 健康结论的许可，例如用户取消或 4xx 请求错误。
   * closed 请求无需占位；half-open 探针必须释放，避免熔断器永久卡死。
   */
  release(permit: CircuitPermit): void {
    if (
      this.state.phase === 'half-open'
      && permit.mode === 'probe'
      && this.state.generation === permit.generation
      && this.state.probeId === permit.requestId
    ) {
      this.state = { ...this.state, probeId: null };
    }
  }

  get phase(): CircuitState['phase'] {
    return this.state.phase;
  }

  private matches(permit: CircuitPermit): boolean {
    if (this.state.generation !== permit.generation) return false;
    if (this.state.phase === 'open') return false;

    if (permit.mode === 'closed') return this.state.phase === 'closed';
    return this.state.phase === 'half-open'
      && this.state.probeId === permit.requestId;
  }

  private openError(since: number): CircuitOpenError {
    return new CircuitOpenError(
      `LLM circuit breaker open - cooling down until ${new Date(since + this.cooldownMs).toISOString()}`,
      since,
    );
  }

  private assertPositiveInteger(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer, got ${value}`);
    }
  }

  private assertNonNegativeInteger(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer, got ${value}`);
    }
  }
}

export interface LlmStreamRuntimeOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** 测试可注入零延迟实现；生产默认使用真实 timer。 */
  wait?: (ms: number) => Promise<void>;
  circuitBreaker?: CircuitBreakerOptions;
}

export type LlmCompatibilityRecovery = (
  error: unknown,
  nextAttempt: number,
) => LlmStreamChunk | undefined;

/**
 * LLM Provider 流运行时。
 *
 * LanguageModelRuntime 传入已准备的调用；本类统一管理 per-provider 熔断、首 chunk 前重试、
 * 首 chunk 后禁止重试、取消分类和 done 终态验证。
 */
export class LlmStreamRuntime {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly circuitBreakerOptions: CircuitBreakerOptions;

  constructor(options: LlmStreamRuntimeOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.wait = options.wait ?? sleep;
    this.circuitBreakerOptions = options.circuitBreaker ?? {};

    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts <= 0) {
      throw new RangeError(`maxAttempts must be a positive safe integer, got ${this.maxAttempts}`);
    }
    if (!Number.isSafeInteger(this.baseDelayMs) || this.baseDelayMs < 0) {
      throw new RangeError(`baseDelayMs must be a non-negative safe integer, got ${this.baseDelayMs}`);
    }
  }

  /** 返回惰性流；许可在消费开始时申请，避免未消费的 half-open 流永久占住探针。 */
  stream(
    providerId: string,
    start: () => AsyncIterable<LlmStreamChunk>,
    signal?: AbortSignal,
    recoverCompatibility?: LlmCompatibilityRecovery,
  ): AsyncIterable<LlmStreamChunk> {
    const breaker = this.breakerFor(providerId);
    return this.run(providerId, breaker, start, signal, recoverCompatibility);
  }

  /** Provider 配置被替换或删除时丢弃旧健康状态。 */
  reset(providerId: string): void {
    this.breakers.delete(providerId);
  }

  private breakerFor(providerId: string): CircuitBreaker {
    let breaker = this.breakers.get(providerId);
    if (!breaker) {
      breaker = new CircuitBreaker(this.circuitBreakerOptions);
      this.breakers.set(providerId, breaker);
    }
    return breaker;
  }

  private async *run(
    providerId: string,
    breaker: CircuitBreaker,
    start: () => AsyncIterable<LlmStreamChunk>,
    signal?: AbortSignal,
    recoverCompatibility?: LlmCompatibilityRecovery,
  ): AsyncIterable<LlmStreamChunk> {
    const permit = breaker.guard();

    try {
      for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
        let emittedChunk = false;

        try {
          if (signal?.aborted) throwAbortReason(signal);

          for await (const chunk of start()) {
            emittedChunk = true;

            if (chunk.type === 'done') {
              // done 是统一流协议的唯一成功终态。先提交健康结论，再交付终态事件。
              breaker.success(permit);
              yield chunk;
              return;
            }

            yield chunk;
          }

          if (signal?.aborted) throwAbortReason(signal);
          throw new LlmStreamProtocolError(providerId);
        } catch (error) {
          // 用户取消不是 Provider 故障，不影响熔断统计，也不允许重试。
          if (isAbortError(error, signal)) throw error;

          // 兼容恢复与网络重试共享 maxAttempts，且只能发生在首个 Provider
          // chunk 前。request_degraded 是诊断，不属于模型输出。
          const compatibilityEvent = !emittedChunk && attempt < this.maxAttempts - 1
            ? recoverCompatibility?.(error, attempt + 2)
            : undefined;
          if (compatibilityEvent) {
            yield compatibilityEvent;
            continue;
          }

          const countsAsProviderFailure =
            error instanceof LlmStreamProtocolError || isRetryable(error);

          if (countsAsProviderFailure) {
            breaker.failure(permit);
          } else {
            breaker.release(permit);
          }

          // 一旦交付任意 chunk，重试会复制文本或工具副作用。
          if (
            emittedChunk
            || !countsAsProviderFailure
            || breaker.phase === 'open'
            || attempt === this.maxAttempts - 1
          ) {
            throw error;
          }

          await this.wait(this.baseDelayMs * 2 ** attempt);
        }
      }
    } finally {
      // 消费者可能通过 iterator.return() 在 done 前停止，finally 是唯一可靠的释放边界。
      breaker.release(permit);
    }
  }
}
