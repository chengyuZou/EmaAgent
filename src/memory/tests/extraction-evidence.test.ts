// 测试提取举证校验、未配置模型的显式跳过事件与 CHAT 排除列表。

import { describe, expect, it, vi } from 'vitest';
import {
  Database,
  MemoryNodesRepo,
  MemoryEdgesRepo,
  MemoryLazyUpdatesRepo,
  MemoryItemsRepo,
  MemoryNodeSourcesRepo,
  PendingFragmentsRepo,
  SessionNotesRepo,
  MemoryExtractionRunsRepo,
} from '@ema-agent/storage';
import { runExtraction } from '../extract/llm-call.js';
import { buildExtractionPrompt } from '../extract/prompts.js';
import { runExtractionPipeline } from '../extract/pipeline.js';
import { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';
import { DEFAULT_MEMORY_SETTINGS } from '../types.js';
import type { MemoryDeps } from '../deps.js';
import type { EmbedService } from '../embed/service.js';
import type { LanguageModel } from '@ema-agent/llm';

const SOURCE = '[user] 我家猫叫橘子，今年三岁了\n[assistant] 橘子真可爱！';

function llmReturning(payload: unknown): LanguageModel {
  return {
    complete: vi.fn(async () => ({
      blocks: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    })),
  } as unknown as LanguageModel;
}

const bindings = {
  get: () => ({ providerConfigId: 'provider-test', model: 'model-test' }),
};

function nodePayload(quote: string | undefined): unknown {
  return {
    new_nodes: quote === undefined
      ? [{ label: '橘子', node_type: 'entity', description: '用户的猫', importance: 80 }]
      : [{ label: '橘子', node_type: 'entity', description: '用户的猫', importance: 80, evidence_quote: quote }],
    new_edges: [],
    memory_items: [],
    session_note_delta: '',
  };
}

describe('提取举证校验', () => {
  it('引用真实存在于原文时保留', async () => {
    const output = await runExtraction(
      llmReturning(nodePayload('我家猫叫橘子，今年三岁了')),
      bindings as never,
      'prompt',
      undefined,
      SOURCE,
    );
    expect(output?.new_nodes).toHaveLength(1);
    expect(output?.new_nodes[0]!.evidenceQuote).toBe('我家猫叫橘子，今年三岁了');
  });

  it('引用缺失或过短时整条丢弃', async () => {
    const missing = await runExtraction(
      llmReturning(nodePayload(undefined)), bindings as never, 'prompt', undefined, SOURCE,
    );
    expect(missing?.new_nodes).toHaveLength(0);

    const tooShort = await runExtraction(
      llmReturning(nodePayload('猫')), bindings as never, 'prompt', undefined, SOURCE,
    );
    expect(tooShort?.new_nodes).toHaveLength(0);
  });

  it('引用不在原文（LLM 编造）时整条丢弃', async () => {
    const output = await runExtraction(
      llmReturning(nodePayload('用户养了一只叫小明的弟弟')),
      bindings as never,
      'prompt',
      undefined,
      SOURCE,
    );
    expect(output?.new_nodes).toHaveLength(0);
  });

  it('空白差异不影响逐字校验（归一化后匹配）', async () => {
    const source = '[user] 第一行\n第二行  有两个空格';
    const output = await runExtraction(
      llmReturning(nodePayload('第二行 有两个空格')),
      bindings as never,
      'prompt',
      undefined,
      source,
    );
    expect(output?.new_nodes).toHaveLength(1);
  });

  it('未配置 memory 模型时返回 null', async () => {
    const output = await runExtraction(
      llmReturning(nodePayload('我家猫叫橘子，今年三岁了')),
      { get: () => undefined } as never,
      'prompt',
      undefined,
      SOURCE,
    );
    expect(output).toBeNull();
  });
});

describe('CHAT 排除列表', () => {
  it('CHAT 提取 prompt 包含临时状态排除段', () => {
    const prompt = buildExtractionPrompt({
      executionProfile: 'chat',
      fragments: [{ role: 'user', content: '明天要出差' }],
      existingNodeLabels: [],
    });
    expect(prompt).toContain('DO NOT extract');
    expect(prompt).toContain('临时状态与日程');
    expect(prompt).toContain('一次性情绪');
  });
});

describe('未配置模型的显式跳过', () => {
  it('丢弃非空 buffer 时发出 memory_extraction_skipped 并清空', async () => {
    const profileDb = new Database({ memory: true, kind: 'profile' });
    const dataDb = new Database({ memory: true, kind: 'data' });
    profileDb.migrate();
    dataDb.migrate();

    const sessionId = 'session-skip';
    const turnId = 'turn-skip';
    dataDb.sqlite
      .prepare(
        `INSERT INTO sessions
           (id, title, last_activity_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, 'R5', 1, 1, 1);
    dataDb.sqlite
      .prepare(
        `INSERT INTO turns
           (id, session_id, trigger_type, execution_profile, narrative_policy, status, user_input, started_at)
         VALUES (?, ?, 'userMessage', 'chat', 'auto', 'completed', 'hello', ?)`,
      )
      .run(turnId, sessionId, 1);

    const pending = new PendingFragmentsRepo(dataDb.sqlite);
    pending.insert({
      id: 'fragment-skip',
      sessionId,
      turnId,
      role: 'user',
      content: '一些值得记住的内容',
      at: 1,
      createdAt: 1,
    });

    const emit = vi.fn();
    const deps = {
      llm: { complete: vi.fn() },
      modelBindings: { get: () => undefined },
      nodes: new MemoryNodesRepo(profileDb.sqlite),
      edges: new MemoryEdgesRepo(profileDb.sqlite),
      lazyUpdates: new MemoryLazyUpdatesRepo(profileDb.sqlite),
      nodeSources: new MemoryNodeSourcesRepo(profileDb.sqlite),
      items: new MemoryItemsRepo(profileDb.sqlite),
      sessionNotes: new SessionNotesRepo(dataDb.sqlite),
      pendingFragments: pending,
      extractionRuns: new MemoryExtractionRunsRepo(profileDb.sqlite),
      runProfileTransaction: <T>(work: () => T): T => profileDb.sqlite.transaction(work)(),
      runDataTransaction: <T>(work: () => T): T => dataDb.sqlite.transaction(work)(),
      emit,
    } as unknown as MemoryDeps;

    await runExtractionPipeline(
      {
        memory: deps,
        embed: { embedMany: vi.fn(async () => null) } as unknown as EmbedService,
        settings: DEFAULT_MEMORY_SETTINGS,
        nodesIndex: null,
        itemsIndex: null,
        indexSpaceId: null,
        commitCoordinator: new MemoryCommitCoordinator(),
      },
      { sessionId, executionProfile: 'chat', runId: 'run-skip', skipConsolidation: true },
    );

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'memory_extraction_skipped',
      sessionId,
    }));
    expect(pending.countBySession(sessionId)).toBe(0);

    profileDb.close();
    dataDb.close();
  });
});
