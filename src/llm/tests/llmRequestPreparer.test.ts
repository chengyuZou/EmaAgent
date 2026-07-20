// 测试 LLM 请求快照、模型输出上限裁剪和推理能力补全，不修改调用方原始消息。
import { describe, expect, it } from 'vitest';
import { LlmRequestPreparer } from '../llmRequestPreparer.js';
import { LlmModelCapabilityError } from '../errors.js';
import type { ModelCapabilitySnapshot } from '../modelCapabilities.js';
import type { LlmRequest } from '../types.js';

function capabilities(overrides: Partial<ModelCapabilitySnapshot> = {}): ModelCapabilitySnapshot {
  return {
    input: {
      text: 'supported',
      image: 'unsupported',
      audio: 'unsupported',
      file: 'unsupported',
    },
    tools: 'supported',
    reasoning: 'supported',
    temperature: 'supported',
    contextWindow: 8_192,
    maxOutput: 1_024,
    source: 'catalog',
    ...overrides,
  };
}

describe('LlmRequestPreparer', () => {
  it('输出预算未指定时保持未指定，不把模型上限当作默认值', () => {
    const preparer = new LlmRequestPreparer({
      capabilitiesFor: () => capabilities(),
    });

    const prepared = preparer.prepare(request(), 'openai-llm');

    expect(prepared.maxTokens).toBeUndefined();
  });

  it('调用方预算超过模型上限时裁剪到模型上限', () => {
    const preparer = new LlmRequestPreparer({
      capabilitiesFor: () => capabilities({ maxOutput: 512 }),
    });

    const prepared = preparer.prepare({ ...request(), maxTokens: 2_048 }, 'openai-llm');

    expect(prepared.maxTokens).toBe(512);
  });

  it('创建结构快照且不复制附件数据，调用方后续修改不会改变已准备请求', () => {
    const preparer = new LlmRequestPreparer({
      capabilitiesFor: () => capabilities({
        input: {
          text: 'supported',
          image: 'supported',
          audio: 'unsupported',
          file: 'unsupported',
        },
      }),
    });
    const imageData = 'base64-image-data';
    const original: LlmRequest = {
      ...request(),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '原始问题' },
          { type: 'image_data', data: imageData, mimeType: 'image/png' },
        ],
      }],
    };

    const prepared = preparer.prepare(original, 'openai-llm');
    const originalContent = original.messages[0]?.role === 'user'
      && Array.isArray(original.messages[0].content)
      ? original.messages[0].content
      : [];
    const preparedContent = prepared.messages[0]?.role === 'user'
      && Array.isArray(prepared.messages[0].content)
      ? prepared.messages[0].content
      : [];
    const originalText = originalContent[0];
    if (originalText?.type === 'text') originalText.text = '被调用方修改';

    expect(prepared.messages).not.toBe(original.messages);
    expect(preparedContent).not.toBe(originalContent);
    expect(preparedContent[0]).toEqual({ type: 'text', text: '原始问题' });
    expect(preparedContent[1]).toEqual({
      type: 'image_data',
      data: imageData,
      mimeType: 'image/png',
    });
  });

  it('Catalog 明确不支持 Tool 时在进入 Adapter 前拒绝请求', () => {
    const preparer = new LlmRequestPreparer({
      capabilitiesFor: () => capabilities({ tools: 'unsupported' }),
    });

    expect(() => preparer.prepare({
      ...request(),
      tools: [{
        name: 'read_file',
        description: '读取文件',
        parameters: { type: 'object', properties: {} },
      }],
    }, 'openai-llm')).toThrow(expect.objectContaining({
      name: 'LlmModelCapabilityError',
      issues: [expect.objectContaining({ kind: 'feature', feature: 'tools' })],
    }) as LlmModelCapabilityError);
  });

  it('Catalog 明确不支持推理时拒绝强制开启 Thinking', () => {
    const preparer = new LlmRequestPreparer({
      capabilitiesFor: () => capabilities({ reasoning: 'unsupported' }),
    });

    expect(() => preparer.prepare({
      ...request(),
      thinking: { enabled: true },
    }, 'openai-llm')).toThrow(expect.objectContaining({
      name: 'LlmModelCapabilityError',
      issues: [expect.objectContaining({ kind: 'feature', feature: 'reasoning' })],
    }) as LlmModelCapabilityError);
  });

});

function request(): LlmRequest {
  return {
    providerId: 'provider-1',
    model: 'model-1',
    messages: [{ role: 'user', content: 'hello' }],
  };
}
