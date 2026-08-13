/**
 * semantic-concurrency.test.ts — B-073 embedBatches 有界并发池。
 *
 * 覆盖:峰值并发 ≤ concurrency、结果按输入顺序、部分 batch 失败不杀其他、
 * abort 不领新任务、concurrency clamp。
 */
import { describe, expect, it } from 'vitest';
import type { EmbeddingModel } from '@ema-agent/embed';
import { embedBatches } from '../chunking/semantic.js';

interface MockState {
  calls:    number;
  inFlight: number;
  peak:     number;
}

/**
 * 构造 mock EmbeddingModel。每个 text 形如 "N"（数字字符串），返回向量 [N]。
 * failOnCall:命中该 batchIndex(按调用顺序)时抛 429。
 * delayMs:每次 embed 人为延迟,用于放大并发窗口观测峰值。
 */
function makeEmbedding(state: MockState, opts: { delayMs?: number; failOnCall?: Set<number>; failStatus?: number; failMessage?: string } = {}): EmbeddingModel {
  const { delayMs = 10, failOnCall, failStatus = 429, failMessage = 'Too Many Requests' } = opts;
  let callIdx = 0;
  const embed = async (req: { texts: string[]; signal?: AbortSignal }): Promise<{ embeddings: number[][] }> => {
    const myCall = callIdx++;
    state.calls++;
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      await new Promise<void>((resolve, reject) => {
        const id = setTimeout(resolve, delayMs);
        req.signal?.addEventListener('abort', () => {
          clearTimeout(id);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
      if (failOnCall?.has(myCall)) {
        const err = new Error(`HTTP ${failStatus} ${failMessage}`) as Error & { status: number };
        err.status = failStatus;
        throw err;
      }
      return { embeddings: req.texts.map(t => [Number(t)]) };
    } finally {
      state.inFlight--;
    }
  };
  return { embed } as unknown as EmbeddingModel;
}

const BASE_OPTS = { model: 'm', batchSize: 2, concurrency: 3, timeoutMs: 5000, maxRetries: 0 };

describe('B-073 embedBatches 有界并发池', () => {
  it('峰值并发不超过 concurrency 上限(且确实并发)', async () => {
    const state: MockState = { calls: 0, inFlight: 0, peak: 0 };
    const runtime = makeEmbedding(state, { delayMs: 20 });
    const texts = Array.from({ length: 20 }, (_, i) => String(i)); // 10 batch
    await embedBatches(texts, runtime, { ...BASE_OPTS, concurrency: 3 });
    expect(state.peak).toBeLessThanOrEqual(3);
    expect(state.peak).toBeGreaterThan(1); // 证明真的并发,非串行
    expect(state.calls).toBe(10);
  });

  it('concurrency > batch 数时 clamp 到 batch 数,不起多余 worker', async () => {
    const state: MockState = { calls: 0, inFlight: 0, peak: 0 };
    const runtime = makeEmbedding(state, { delayMs: 20 });
    const texts = ['0', '1', '2']; // batchSize=2 → 2 batch
    await embedBatches(texts, runtime, { ...BASE_OPTS, concurrency: 100 });
    expect(state.peak).toBeLessThanOrEqual(2);
    expect(state.calls).toBe(2);
  });

  it('结果严格按输入顺序(embeddings[k] 编码原 text 数字)', async () => {
    const state: MockState = { calls: 0, inFlight: 0, peak: 0 };
    const runtime = makeEmbedding(state, { delayMs: 5 });
    const texts = Array.from({ length: 12 }, (_, i) => String(i));
    const { embeddings } = await embedBatches(texts, runtime, { ...BASE_OPTS, concurrency: 4 });
    expect(embeddings.length).toBe(12);
    for (let i = 0; i < 12; i++) {
      expect(embeddings[i]).toEqual([i]); // 顺序与输入对齐,不受并发完成先后影响
    }
  });

  it('部分 batch 失败不拖死其他批:失败位填 [],成功位有值,failedBatches 记录', async () => {
    const state: MockState = { calls: 0, inFlight: 0, peak: 0 };
    // 让第 1 次调用(batch 1,覆盖 text "2"/"3")抛 401,maxRetries=0 直接耗尽,
    // 失败消息收敛为统一的重试耗尽文案。
    const runtime = makeEmbedding(state, { delayMs: 5, failOnCall: new Set([1]), failStatus: 401, failMessage: 'api_key_invalid' });
    const texts = Array.from({ length: 8 }, (_, i) => String(i)); // 4 batch
    const { embeddings, failedBatches } = await embedBatches(texts, runtime, { ...BASE_OPTS, concurrency: 2, maxRetries: 0 });
    expect(embeddings.length).toBe(8);
    // batch 1 对应 text "2","3" → 失败位填 []
    expect(embeddings[2]).toEqual([]);
    expect(embeddings[3]).toEqual([]);
    // 其他位仍有值
    expect(embeddings[0]).toEqual([0]);
    expect(embeddings[4]).toEqual([4]);
    expect(failedBatches).toHaveLength(1);
    expect(failedBatches[0]!.batchIndex).toBe(1);
    expect(failedBatches[0]!.error).toContain('failed after retries');
    expect(failedBatches[0]!.sentenceCount).toBe(2);
  });

  it('预先 abort:不领任何任务,embeddings 全 [] 保长度守恒,无 failedBatches', async () => {
    const state: MockState = { calls: 0, inFlight: 0, peak: 0 };
    const runtime = makeEmbedding(state, { delayMs: 20 });
    const ctrl = new AbortController();
    ctrl.abort(new Error('user cancelled'));
    const texts = Array.from({ length: 6 }, (_, i) => String(i)); // 3 batch
    const { embeddings, failedBatches } = await embedBatches(texts, runtime, { ...BASE_OPTS, concurrency: 3, signal: ctrl.signal });
    // worker 入口即 return,embed 一次都没真正发出
    expect(state.calls).toBe(0);
    expect(embeddings.length).toBe(6);
    expect(embeddings.every(v => v.length === 0)).toBe(true);
    expect(failedBatches).toHaveLength(0); // abort 不算 embed 失败
  });

  it('空输入:不起 worker,返回空', async () => {
    const state: MockState = { calls: 0, inFlight: 0, peak: 0 };
    const runtime = makeEmbedding(state);
    const { embeddings, failedBatches } = await embedBatches([], runtime, { ...BASE_OPTS });
    expect(embeddings).toEqual([]);
    expect(failedBatches).toEqual([]);
    expect(state.calls).toBe(0);
  });
});
