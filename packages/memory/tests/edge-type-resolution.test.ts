// 测试 B-076 边端点 type 消歧: 同名多 type 节点的边精确落点,
// label 唯一时宽容兜底, 歧义无 type 丢边计数而不是静默连错。

import { describe, expect, it, vi } from 'vitest';
import { NodeDirectory } from '../src/extract/node-directory.js';
import { processEdges } from '../src/extract/route-edges.js';
import type { ExtractionPipelineDeps, PipelineResult } from '../src/extract/pipeline.js';
import type { ExtractionOutput } from '../src/extract/types.js';

function makeDeps() {
  const upsert = vi.fn();
  const deps = { memory: { edges: { upsert } } } as unknown as ExtractionPipelineDeps;
  return { deps, upsert };
}

function makeStats(): PipelineResult {
  return {
    extractedNodes: 0, extractedEdges: 0, extractedItems: 0,
    lazyUpdatesQueued: 0, consolidatedNodes: 0, droppedEdges: 0,
  };
}

function outputWith(edges: ExtractionOutput['new_edges']): ExtractionOutput {
  return { new_nodes: [], new_edges: edges, memory_items: [], session_note_delta: '' };
}

/** 同名双 type 场景: "苹果" 既是 entity(公司) 又是 preference(喜好对象)。 */
function dualAppleDirectory(): NodeDirectory {
  const directory = new NodeDirectory();
  directory.register('苹果', 'entity', 'id-apple-entity');
  directory.register('苹果', 'preference', 'id-apple-pref');
  directory.register('橘子', 'entity', 'id-orange');
  directory.register('iPhone', 'entity', 'id-iphone');
  return directory;
}

describe('B-076 边端点 type 消歧', () => {
  it('端点带 type 时精确命中, 不被同名节点覆盖', () => {
    const { deps, upsert } = makeDeps();
    const stats = makeStats();
    processEdges(deps, outputWith([
      { fromLabel: '苹果', fromType: 'entity', toLabel: 'iPhone', toType: 'entity', relation: '生产' },
    ]), stats, dualAppleDirectory());

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![0]).toMatchObject({ fromNodeId: 'id-apple-entity', toNodeId: 'id-iphone' });
    expect(stats.extractedEdges).toBe(1);
    expect(stats.droppedEdges).toBe(0);
  });

  it('label 全库唯一时, 没给 type 也宽容兜底', () => {
    const { deps, upsert } = makeDeps();
    const stats = makeStats();
    processEdges(deps, outputWith([
      { fromLabel: '橘子', toLabel: 'iPhone', relation: '竞争' },
    ]), stats, dualAppleDirectory());

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(stats.extractedEdges).toBe(1);
    expect(stats.droppedEdges).toBe(0);
  });

  it('同名多 type 且不给 type: 丢边并计数, 不再静默连错', () => {
    const { deps, upsert } = makeDeps();
    const stats = makeStats();
    processEdges(deps, outputWith([
      { fromLabel: '苹果', toLabel: '橘子', relation: '喜欢' },
    ]), stats, dualAppleDirectory());

    expect(upsert).not.toHaveBeenCalled();
    expect(stats.extractedEdges).toBe(0);
    expect(stats.droppedEdges).toBe(1);
  });

  it('type 给了但 (label,type) 不存在: label 唯一时仍兜底连上', () => {
    const { deps, upsert } = makeDeps();
    const stats = makeStats();
    processEdges(deps, outputWith([
      { fromLabel: '橘子', fromType: 'event', toLabel: 'iPhone', relation: '涉及' },
    ]), stats, dualAppleDirectory());

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![0]).toMatchObject({ fromNodeId: 'id-orange' });
    expect(stats.droppedEdges).toBe(0);
  });

  it('自环边跳过且不计入丢弃数', () => {
    const { deps, upsert } = makeDeps();
    const stats = makeStats();
    processEdges(deps, outputWith([
      { fromLabel: '橘子', fromType: 'entity', toLabel: '橘子', toType: 'entity', relation: '自指' },
    ]), stats, dualAppleDirectory());

    expect(upsert).not.toHaveBeenCalled();
    expect(stats.droppedEdges).toBe(0);
  });

  it('NodeDirectory: register/resolve/resolveUnique 的唯一与歧义语义', () => {
    const directory = dualAppleDirectory();
    expect(directory.resolve('苹果', 'entity')).toBe('id-apple-entity');
    expect(directory.resolve('苹果', 'emotion')).toBeUndefined();
    expect(directory.resolveUnique('橘子')).toBe('id-orange');
    expect(directory.resolveUnique('苹果')).toBeUndefined();
    expect(directory.resolveUnique('不存在')).toBeUndefined();
  });
});
