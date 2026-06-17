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
  private releaseExtract: (() => void) | undefined;
  private resolveStarted: () => void = () => {};

  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  async extract(request: VisionAdapterCall): Promise<VisionExtractionResult> {
    this.requests.push(request);
    this.resolveStarted();
    await new Promise<void>((resolve) => {
      this.releaseExtract = resolve;
    });
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
    this.releaseExtract?.();
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

  it('shares concurrency limits inside the singleton router instance', async () => {
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

    await expect(vision.extract({
      providerId: 'provider-1',
      model: 'vision-model',
      task: 'ocr',
      inputs: [{
        kind: 'base64',
        data: 'aGVsbG8=',
        mimeType: 'image/png',
      }],
    })).rejects.toMatchObject({
      code: 'vision/concurrency_limited',
    });

    adapter.release();
    await expect(running).resolves.toMatchObject({ text: 'done' });
  });
});
