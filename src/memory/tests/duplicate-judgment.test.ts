// 测试节点同一性 LLM 判定与 route-nodes 的判定消费。

import { describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@ema-agent/llm';
import { judgeDuplicateEntity } from '../extract/duplicate-judgment.js';
import {
  planNodeDuplicateJudgments,
  routeCandidateNode,
  type NodeDuplicateJudgment,
} from '../extract/route-nodes.js';
import type { ExtractionPipelineDeps, PipelineResult } from '../extract/pipeline.js';
import type { ExtractedNode } from '../extract/types.js';
import type { NodeDirectory } from '../extract/node-directory.js';
import type { VectorIndex } from '../vector-index/vector-index.js';

const BINDING = { providerConfigId: 'provider-test', model: 'model-test' };

function llmWithText(text: string): LanguageModel {
  return {
    complete: vi.fn(async () => ({
      blocks: [{ type: 'text' as const, text }],
    })),
  } as unknown as LanguageModel;
}

function bindingsWith(binding: unknown) {
  return { get: () => binding };
}

describe('judgeDuplicateEntity', () => {
  const input = {
    candidateLabel: '苹果手机',
    candidateDescription: '用户上周买的 iPhone 17',
    existingLabel: '苹果',
    existingDescription: '用户喜欢吃的水果',
  };

  it('判 same 返回 true，判 different 返回 false', async () => {
    expect(await judgeDuplicateEntity(
      llmWithText('{"same": true}'), bindingsWith(BINDING) as never, input,
    )).toBe(true);
    expect(await judgeDuplicateEntity(
      llmWithText('{"same": false}'), bindingsWith(BINDING) as never, input,
    )).toBe(false);
  });

  it('输出无法解析、未配置模型或调用失败都返回 null', async () => {
    expect(await judgeDuplicateEntity(
      llmWithText('我觉得可能是一样的吧'), bindingsWith(BINDING) as never, input,
    )).toBeNull();
    expect(await judgeDuplicateEntity(
      llmWithText('{"same": true}'), bindingsWith(undefined) as never, input,
    )).toBeNull();
    expect(await judgeDuplicateEntity(
      { complete: vi.fn(async () => { throw new Error('provider down'); }) } as unknown as LanguageModel,
      bindingsWith(BINDING) as never,
      input,
    )).toBeNull();
  });
});

describe('planNodeDuplicateJudgments', () => {
  const candidate: ExtractedNode = {
    label: '苹果手机',
    nodeType: 'entity',
    description: '用户上周买的 iPhone 17',
    importance: 60,
    evidenceQuote: '我上周买了 iPhone 17',
  };
  const embedding = {
    embedding: Buffer.alloc(8),
    providerId: 'p',
    model: 'm',
    dim: 2,
    space: { id: 'space-1' },
  };

  function createDeps(verdictText: string) {
    const index = {
      dim: 2,
      search: vi.fn(() => [{ id: 'node-apple', score: 0.9 }]),
    } as unknown as VectorIndex;
    const nodes = {
      findByLabelAndType: vi.fn(() => undefined),
      findById: vi.fn(() => ({
        id: 'node-apple',
        label: '苹果',
        node_type: 'entity',
        description: '用户喜欢吃的水果',
      })),
    };
    const deps = {
      memory: {
        nodes,
        llm: llmWithText(verdictText),
        modelBindings: bindingsWith(BINDING),
      },
      nodesIndex: index,
      indexSpaceId: 'space-1',
    } as unknown as ExtractionPipelineDeps;
    return { deps, nodes };
  }

  it('embedding 命中后经 LLM 判定：判 same 才归并，判 different 保守新建', async () => {
    const same = await planNodeDuplicateJudgments(
      createDeps('{"same": true}').deps,
      { new_nodes: [candidate], new_edges: [], memory_items: [], session_note_delta: '' },
      [embedding as never],
    );
    expect(same.get(0)).toEqual({ targetNodeId: 'node-apple', merge: true });

    const different = await planNodeDuplicateJudgments(
      createDeps('{"same": false}').deps,
      { new_nodes: [candidate], new_edges: [], memory_items: [], session_note_delta: '' },
      [embedding as never],
    );
    expect(different.get(0)).toEqual({ targetNodeId: 'node-apple', merge: false });
  });

  it('判定不可用时 merge=false（保守新建）', async () => {
    const judgments = await planNodeDuplicateJudgments(
      createDeps('这不是 JSON').deps,
      { new_nodes: [candidate], new_edges: [], memory_items: [], session_note_delta: '' },
      [embedding as never],
    );
    expect(judgments.get(0)).toEqual({ targetNodeId: 'node-apple', merge: false });
  });
});

describe('routeCandidateNode 消费判定', () => {
  function createRouteDeps() {
    const lazyUpdates = { append: vi.fn() };
    const nodes = {
      findByLabelAndType: vi.fn(() => undefined),
      findById: vi.fn(() => ({
        id: 'node-apple',
        label: '苹果',
        node_type: 'entity',
      })),
      insert: vi.fn(() => ({ id: 'new-id' })),
    };
    const deps = {
      memory: { nodes, lazyUpdates },
      nodesIndex: null,
      indexSpaceId: null,
    } as unknown as ExtractionPipelineDeps;
    const stats: PipelineResult = {
      extractedNodes: 0,
      extractedEdges: 0,
      extractedItems: 0,
      lazyUpdatesQueued: 0,
      consolidatedNodes: 0,
      droppedEdges: 0,
    };
    const directory = { register: vi.fn() } as unknown as NodeDirectory;
    return { deps, nodes, lazyUpdates, stats, directory };
  }

  const candidate: ExtractedNode = {
    label: '苹果手机',
    nodeType: 'entity',
    description: '用户上周买的 iPhone 17',
    importance: 60,
    evidenceQuote: '我上周买了 iPhone 17',
  };

  it('判定 merge=true 时归并到既有节点，不新建', () => {
    const { deps, nodes, lazyUpdates, stats, directory } = createRouteDeps();
    const judgment: NodeDuplicateJudgment = { targetNodeId: 'node-apple', merge: true };

    routeCandidateNode(deps, 'session-1' as never, candidate, null, [], stats, directory, [], judgment);

    expect(lazyUpdates.append).toHaveBeenCalledOnce();
    expect(nodes.insert).not.toHaveBeenCalled();
    expect(stats.lazyUpdatesQueued).toBe(1);
  });

  it('判定 merge=false 或缺失时正常新建节点', () => {
    const { deps, nodes, lazyUpdates, stats, directory } = createRouteDeps();

    routeCandidateNode(deps, 'session-1' as never, candidate, null, [], stats, directory, [], { targetNodeId: 'node-apple', merge: false });

    expect(nodes.insert).toHaveBeenCalledOnce();
    expect(lazyUpdates.append).not.toHaveBeenCalled();
  });
});
