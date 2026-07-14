import { describe, expect, it } from 'vitest';
import {
  VisionRouter,
  type VisionAdapter,
  type VisionAdapterCall,
  type VisionExtractionResult,
  type VisionProviderConfig,
} from '../src/index.js';

const CONFIG: VisionProviderConfig = {
  id: 'provider-1',
  protocol: 'openai-vision',
  apiKey: 'test-key',
  defaultModel: 'vision-model',
};

class MockAdapter implements VisionAdapter {
  readonly requests: VisionAdapterCall[] = [];

  constructor(private readonly result: VisionExtractionResult) {}

  async extract(request: VisionAdapterCall): Promise<VisionExtractionResult> {
    this.requests.push(request);
    return this.result;
  }
}

class BlockingAdapter implements VisionAdapter {
  readonly requests: VisionAdapterCall[] = [];
  private readonly releaseExtract: Array<() => void> = [];
  private resolveStarted: () => void = () => {};
  private released = false;

  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  async extract(request: VisionAdapterCall): Promise<VisionExtractionResult> {
    this.requests.push(request);
    this.resolveStarted();
    if (!this.released) {
      await new Promise<void>((resolve) => {
        this.releaseExtract.push(resolve);
      });
    }
    return {
      providerId: request.providerId,
      model: request.model,
      task: request.task,
      text: 'done',
      blocks: [{ id: 'block-1', kind: 'text', text: 'done' }],
      sources: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  release(): void {
    this.released = true;
    for (const release of this.releaseExtract.splice(0)) release();
  }
}

describe('VisionRouter', () => {
  it('extracts structured vision output through the configured adapter', async () => {
    const adapter = new MockAdapter({
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'ocr',
      text: 'hello world',
      blocks: [{ id: 'b1', kind: 'text', text: 'hello world' }],
      sources: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const vision = new VisionRouter({
      configs: [CONFIG],
      adapterOverrides: new Map([['provider-1', adapter]]),
    });

    const result = await vision.extract({
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'ocr',
      inputs: [{
        kind: 'base64',
        data: 'aGVsbG8=',
        mimeType: 'image/png',
        name: 'sample.png',
      }],
    });

    expect(result.text).toBe('hello world');
    expect(result.blocks).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]).toMatchObject({
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'ocr',
      parseMode: 'best_effort',
    });
  });

  it('defaults task to auto when the caller does not specify one', async () => {
    const adapter = new MockAdapter({
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'auto',
      text: 'caption',
      blocks: [{ id: 'b1', kind: 'caption', text: 'caption' }],
      sources: [],
    });
    const vision = new VisionRouter({
      configs: [CONFIG],
      adapterOverrides: new Map([['provider-1', adapter]]),
    });

    await vision.extract({
      providerId: 'provider-1',
      model: 'vision-model',
      inputs: [{
        kind: 'url',
        url: 'https://example.test/a.png',
      }],
    });

    expect(adapter.requests[0]?.task).toBe('auto');
  });

  it('enforces payload size limits before calling the provider', async () => {
    const adapter = new MockAdapter({
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'ocr',
      text: '',
      blocks: [],
      sources: [],
    });
    const vision = new VisionRouter({
      configs: [CONFIG],
      adapterOverrides: new Map([['provider-1', adapter]]),
      limits: { maxBytesPerImage: 2 },
    });

    await expect(vision.extract({
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'ocr',
      inputs: [{
        kind: 'bytes',
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'image/png',
      }],
    })).rejects.toMatchObject({
      code: 'vision/payload_too_large',
    });

    expect(adapter.requests).toHaveLength(0);
  });

  it('throws a typed error when the provider is not configured', async () => {
    const vision = new VisionRouter({ configs: [CONFIG] });

    await expect(vision.extract({
      providerId: 'missing-provider',
      model: 'vision-model',
      task: 'ocr',
      inputs: [{
        kind: 'base64',
        data: 'aGVsbG8=',
        mimeType: 'image/png',
      }],
    })).rejects.toMatchObject({
      code: 'vision/not_configured',
    });
  });

  it('shares concurrency limits and applies backpressure instead of dropping work', async () => {
    const adapter = new BlockingAdapter();
    const vision = new VisionRouter({
      configs: [CONFIG],
      adapterOverrides: new Map([['provider-1', adapter]]),
      limits: { maxConcurrentGlobal: 1, maxConcurrentPerProvider: 1 },
    });

    const running = vision.extract({
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'ocr',
      inputs: [{
        kind: 'base64',
        data: 'aGVsbG8=',
        mimeType: 'image/png',
      }],
    });
    await adapter.started;

    const queued = vision.extract({
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'ocr',
      inputs: [{
        kind: 'base64',
        data: 'aGVsbG8=',
        mimeType: 'image/png',
      }],
    });

    await Promise.resolve();
    expect(adapter.requests).toHaveLength(1);

    adapter.release();
    await expect(running).resolves.toMatchObject({ text: 'done' });
    await expect(queued).resolves.toMatchObject({ text: 'done' });
    expect(adapter.requests).toHaveLength(2);
  });

  it('queues the third KB-style OCR request when the provider limit is two', async () => {
    const adapter = new BlockingAdapter();
    const vision = new VisionRouter({
      configs: [CONFIG],
      adapterOverrides: new Map([['provider-1', adapter]]),
      limits: { maxConcurrentGlobal: 4, maxConcurrentPerProvider: 2 },
    });
    const request = {
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'ocr' as const,
      inputs: [{ kind: 'base64' as const, data: 'aGVsbG8=', mimeType: 'image/png' as const }],
    };

    const calls = [vision.extract(request), vision.extract(request), vision.extract(request)];
    await Promise.resolve();
    expect(adapter.requests).toHaveLength(2);

    adapter.release();
    await expect(Promise.all(calls)).resolves.toHaveLength(3);
    expect(adapter.requests).toHaveLength(3);
  });

  it('aborts a request while it is waiting for a concurrency slot', async () => {
    const adapter = new BlockingAdapter();
    const vision = new VisionRouter({
      configs: [CONFIG],
      adapterOverrides: new Map([['provider-1', adapter]]),
      limits: { maxConcurrentGlobal: 1, maxConcurrentPerProvider: 1 },
    });
    const request = {
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'ocr' as const,
      inputs: [{ kind: 'base64' as const, data: 'aGVsbG8=', mimeType: 'image/png' as const }],
    };
    const running = vision.extract(request);
    await adapter.started;

    const controller = new AbortController();
    const queued = vision.extract({ ...request, signal: controller.signal });
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(queued).rejects.toMatchObject({ code: 'vision/aborted' });
    expect(adapter.requests).toHaveLength(1);
    adapter.release();
    await running;
  });

  it('keeps the wait queue bounded', async () => {
    const adapter = new BlockingAdapter();
    const vision = new VisionRouter({
      configs: [CONFIG],
      adapterOverrides: new Map([['provider-1', adapter]]),
      limits: {
        maxConcurrentGlobal: 1,
        maxConcurrentPerProvider: 1,
        maxQueuedRequests: 0,
      },
    });
    const request = {
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'ocr' as const,
      inputs: [{ kind: 'base64' as const, data: 'aGVsbG8=', mimeType: 'image/png' as const }],
    };
    const running = vision.extract(request);
    await adapter.started;

    await expect(vision.extract(request)).rejects.toMatchObject({
      code: 'vision/concurrency_limited',
    });
    adapter.release();
    await running;
  });

  it('完整快照删除旧 Provider，但不会中断已经开始的识别', async () => {
    const adapter = new BlockingAdapter();
    const vision = new VisionRouter({
      configs: [CONFIG],
      adapterOverrides: new Map([['provider-1', adapter]]),
    });
    const request = {
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'ocr' as const,
      inputs: [{
        kind: 'base64' as const,
        data: 'aGVsbG8=',
        mimeType: 'image/png' as const,
      }],
    };

    const running = vision.extract(request);
    await adapter.started;
    vision.reload([]);

    await expect(vision.extract(request)).rejects.toMatchObject({
      code: 'vision/not_configured',
    });
    adapter.release();
    await expect(running).resolves.toMatchObject({ text: 'done' });
  });
});
