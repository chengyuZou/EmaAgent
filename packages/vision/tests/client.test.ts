import { describe, expect, it } from 'vitest';
import {
  VisionClient,
  type VisionLlmCompletion,
  type VisionLlmContentPart,
  type VisionLlmFacade,
  type VisionLlmRequest,
  type VisionUnsupportedPart,
} from '../src/index.js';

class MockLlm implements VisionLlmFacade {
  readonly requests: VisionLlmRequest[] = [];
  unsupported: VisionUnsupportedPart[] = [];

  constructor(private readonly completion: VisionLlmCompletion) {}

  async complete(request: VisionLlmRequest): Promise<VisionLlmCompletion> {
    this.requests.push(request);
    return this.completion;
  }

  warnUnsupportedParts(_providerId: string, _parts: VisionLlmContentPart[]): VisionUnsupportedPart[] {
    return this.unsupported;
  }
}

class BlockingLlm implements VisionLlmFacade {
  readonly requests: VisionLlmRequest[] = [];
  private releaseComplete: (() => void) | undefined;
  private resolveStarted: () => void = () => {};

  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  async complete(request: VisionLlmRequest): Promise<VisionLlmCompletion> {
    this.requests.push(request);
    this.resolveStarted();
    await new Promise<void>((resolve) => {
      this.releaseComplete = resolve;
    });
    return {
      blocks: [{
        type: 'text',
        text: JSON.stringify({ text: 'done', blocks: [] }),
      }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  warnUnsupportedParts(_providerId: string, _parts: VisionLlmContentPart[]): VisionUnsupportedPart[] {
    return [];
  }

  release(): void {
    this.releaseComplete?.();
  }
}

describe('VisionClient', () => {
  it('extracts structured vision output through the llm backend', async () => {
    const llm = new MockLlm({
      blocks: [{
        type: 'text',
        text: JSON.stringify({
          text: 'hello world',
          blocks: [{ id: 'b1', kind: 'text', text: 'hello world' }],
        }),
      }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const vision = new VisionClient({ llm });

    const result = await vision.extract({
      providerId: 'provider-1',
      model: 'gpt-4o-mini',
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
    expect(llm.requests).toHaveLength(1);
    const content = llm.requests[0]?.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as VisionLlmContentPart[])[1]).toMatchObject({
      type: 'image_data',
      mimeType: 'image/png',
      name: 'sample.png',
    });
  });

  it('throws a typed error for unsupported provider input', async () => {
    const llm = new MockLlm({
      blocks: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    llm.unsupported = [{
      index: 1,
      part: { type: 'image_url', url: 'https://example.test/a.png' },
      reason: 'not supported',
    }];
    const vision = new VisionClient({ llm });

    await expect(vision.extract({
      providerId: 'provider-1',
      model: 'm',
      task: 'caption',
      inputs: [{ kind: 'url', url: 'https://example.test/a.png' }],
    })).rejects.toMatchObject({
      code: 'vision/unsupported_input',
    });
  });

  it('enforces payload size limits before calling the provider', async () => {
    const llm = new MockLlm({
      blocks: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const vision = new VisionClient({
      llm,
      limits: { maxBytesPerImage: 2 },
    });

    await expect(vision.extract({
      providerId: 'provider-1',
      model: 'm',
      task: 'ocr',
      inputs: [{
        kind: 'bytes',
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'image/png',
      }],
    })).rejects.toMatchObject({
      code: 'vision/payload_too_large',
    });

    expect(llm.requests).toHaveLength(0);
  });

  it('can fail strictly when the provider output is not JSON', async () => {
    const llm = new MockLlm({
      blocks: [{ type: 'text', text: 'not json' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const vision = new VisionClient({ llm });

    await expect(vision.extract({
      providerId: 'provider-1',
      model: 'm',
      task: 'ocr',
      parseMode: 'strict',
      inputs: [{
        kind: 'base64',
        data: 'aGVsbG8=',
        mimeType: 'image/png',
      }],
    })).rejects.toMatchObject({
      code: 'vision/output_parse_failed',
    });
  });

  it('shares concurrency limits across VisionClient instances by default', async () => {
    const llm = new BlockingLlm();
    const first = new VisionClient({
      llm,
      limits: { maxConcurrentGlobal: 1, maxConcurrentPerProvider: 1 },
    });
    const second = new VisionClient({
      llm,
      limits: { maxConcurrentGlobal: 1, maxConcurrentPerProvider: 1 },
    });

    const running = first.extract({
      providerId: 'provider-1',
      model: 'm',
      task: 'ocr',
      inputs: [{
        kind: 'base64',
        data: 'aGVsbG8=',
        mimeType: 'image/png',
      }],
    });
    await llm.started;

    await expect(second.extract({
      providerId: 'provider-1',
      model: 'm',
      task: 'ocr',
      inputs: [{
        kind: 'base64',
        data: 'aGVsbG8=',
        mimeType: 'image/png',
      }],
    })).rejects.toMatchObject({
      code: 'vision/concurrency_limited',
    });

    llm.release();
    await expect(running).resolves.toMatchObject({ text: 'done' });
  });
});
