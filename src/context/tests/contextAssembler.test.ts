// 测试 Context 装配顺序、临时贡献隔离、ToolManifest 投影和快照不可变性。
import { describe, expect, it } from 'vitest';
import type { PromptSnapshot } from '@ema-agent/prompts';
import type { ToolManifestSnapshot } from '@ema-agent/tools';
import { ContextAssembler } from '../contextAssembler.js';

const prompt: PromptSnapshot = {
  revision: 'prompt-v1',
  slots: [],
  systemBlocks: [{
    stabilityScope: 'product',
    delivery: 'system',
    content: 'system rules',
    revision: 'product-v1',
    cacheBreakpoint: true,
  }],
  contextBlocks: [],
  revisions: {
    product: 'product-v1',
    activeCharacter: 'character-v1',
    turn: 'turn-v1',
    complete: 'prompt-v1',
  },
};

const manifest: ToolManifestSnapshot = {
  registryVersion: 3,
  revision: 'tools-v3',
  entries: [{
    id: 'tool.read',
    name: 'FileReadTool',
    description: '读取文件',
    inputJsonSchema: { type: 'object', properties: { path: { type: 'string' } } },
  }],
};

describe('ContextAssembler', () => {
  it('按固定边界装配最终模型请求', () => {
    const snapshot = new ContextAssembler().assemble({
      prompt,
      history: [{ role: 'user', content: 'old question' }],
      currentTurn: [{ role: 'user', content: 'current question' }],
      contributions: [
        {
          id: 'memory.recall',
          source: 'memory',
          placement: 'beforeCurrentTurn',
          message: { role: 'user', content: 'recalled facts' },
        },
      ],
      toolManifest: manifest,
    });

    expect(snapshot.messages).toEqual([
      { role: 'system', content: 'system rules', cacheBreakpoint: true },
      { role: 'user', content: 'old question' },
      { role: 'user', content: 'recalled facts' },
      { role: 'user', content: 'current question' },
    ]);
    expect(snapshot.promptRevision).toBe('prompt-v1');
    expect(snapshot.toolManifestRevision).toBe('tools-v3');
    expect(snapshot.tools).toEqual([{
      name: 'FileReadTool',
      description: '读取文件',
      parameters: manifest.entries[0]!.inputJsonSchema,
    }]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.messages)).toBe(true);
    expect(Object.isFrozen(snapshot.messages[0])).toBe(true);
    expect(snapshot.cache).toEqual(expect.objectContaining({
      productPromptRevision: 'product-v1',
      activeCharacterRevision: 'character-v1',
      turnPromptRevision: 'turn-v1',
      toolManifestRevision: 'tools-v3',
      prefixHash: expect.any(String),
    }));
  });

  it('把扩展目录和运行环境放在历史之前且不提升为 System 指令', () => {
    const snapshot = new ContextAssembler().assemble({
      prompt: {
        ...prompt,
        contextBlocks: [{
          stabilityScope: 'turn',
          delivery: 'context',
          content: 'skill catalog',
          revision: 'skills-v1',
          cacheBreakpoint: false,
        }],
      },
      environment: {
        currentDate: '2026-07-22',
        platform: 'win32',
        architecture: 'x64',
        workspaceRoot: 'D:\\workspace',
        providerId: 'provider-1',
        model: 'model-1',
      },
      history: [{ role: 'user', content: 'old question' }],
      currentTurn: [{ role: 'user', content: 'current question' }],
    });

    expect(snapshot.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'user',
      'user',
      'user',
    ]);
    expect(snapshot.messages[1]?.content).toBe('skill catalog');
    expect(snapshot.messages[2]?.content).toContain('当前工作区：D:\\workspace');
  });

  it('拒绝重复的临时贡献身份', () => {
    expect(() => new ContextAssembler().assemble({
      prompt,
      history: [],
      currentTurn: [{ role: 'user', content: 'question' }],
      contributions: [
        {
          id: 'memory.recall',
          source: 'memory',
          placement: 'beforeCurrentTurn',
          message: { role: 'user', content: 'first' },
        },
        {
          id: 'memory.recall',
          source: 'memory',
          placement: 'beforeCurrentTurn',
          message: { role: 'user', content: 'second' },
        },
      ],
    })).toThrow('Context contribution id 重复');
  });

  it('把固定前缀、历史和固定尾部按边界交给压缩器', async () => {
    const assembler = new ContextAssembler();
    const snapshot = await assembler.assembleCompacted({
      prompt,
      history: [{ role: 'user', content: 'old question' }],
      currentTurn: [{ role: 'user', content: 'current question' }],
      contributions: [{
        id: 'memory.recall',
        source: 'memory',
        placement: 'beforeCurrentTurn',
        message: { role: 'user', content: 'recalled facts' },
      }],
    }, async (view) => {
      expect(view.prefixMessages).toEqual([
        { role: 'system', content: 'system rules', cacheBreakpoint: true },
      ]);
      expect(view.historyMessages).toEqual([
        { role: 'user', content: 'old question' },
      ]);
      expect(view.suffixMessages).toEqual([
        { role: 'user', content: 'recalled facts' },
        { role: 'user', content: 'current question' },
      ]);
      return [...view.prefixMessages, { role: 'user', content: 'summary' }, ...view.suffixMessages];
    });

    expect(snapshot.messages.map((message) => message.content)).toEqual([
      'system rules',
      'summary',
      'recalled facts',
      'current question',
    ]);
    expect(snapshot.history).toEqual([{ role: 'user', content: 'summary' }]);
  });
});
