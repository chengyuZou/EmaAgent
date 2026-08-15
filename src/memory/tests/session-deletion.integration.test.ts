// 测试 Session 删除与启动恢复只清理跨库来源软引用，不误删全局 Memory 正文。

import { afterEach, describe, expect, it } from 'vitest';
import {
  Database,
  MemoryExtractionRunsRepo,
  MemoryItemsRepo,
  MemoryLazyUpdatesRepo,
  MemoryNodeSourcesRepo,
  MemoryNodesRepo,
} from '@ema-agent/storage';
import { SessionStore } from '@ema-agent/session';
import type { MemoryDeps } from '../deps.js';
import {
  cleanupOrphanSessionMemoryReferences,
  cleanupSessionMemoryReferences,
} from '../sessionCleanup.js';

const opened: Database[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function createHarness() {
  const profileDb = new Database({ memory: true, kind: 'profile' });
  const dataDb = new Database({ memory: true, kind: 'data' });
  opened.push(profileDb, dataDb);
  profileDb.migrate();
  dataDb.migrate();

  const session = new SessionStore({ db: dataDb });
  const keptSession = session.createSession({ title: 'kept' });
  const deletedSessionId = asSessionId('session-deleted');
  const nodes = new MemoryNodesRepo(profileDb.sqlite);
  const nodeSources = new MemoryNodeSourcesRepo(profileDb.sqlite);
  const lazyUpdates = new MemoryLazyUpdatesRepo(profileDb.sqlite);
  const items = new MemoryItemsRepo(profileDb.sqlite);
  const extractionRuns = new MemoryExtractionRunsRepo(profileDb.sqlite);

  nodes.insert({
    id: 'node-shared',
    label: 'shared',
    nodeType: 'entity',
    description: 'global memory',
    createdAt: 1,
  });
  nodeSources.record('node-shared', deletedSessionId, 'turn-deleted', 1);
  nodeSources.record('node-shared', keptSession.id, 'turn-kept', 2);
  lazyUpdates.append({
    id: 'lazy-deleted',
    nodeId: 'node-shared',
    fragment: 'evidence remains useful',
    sourceSessionId: deletedSessionId,
    sourceTurnId: 'turn-deleted',
    createdAt: 1,
  });
  items.insert({
    id: 'item-deleted',
    kind: 'reference',
    title: 'kept item',
    body: 'long-term content',
    profiles: ['chat'],
    sourceSessionId: deletedSessionId,
    sourceTurnId: 'turn-deleted',
    createdAt: 1,
  });
  extractionRuns.insert({
    runId: 'run-deleted',
    sessionId: deletedSessionId,
    sourceTurnId: 'turn-deleted',
    noteDelta: 'cannot be restored after deletion',
    nodesCount: 1,
    edgesCount: 0,
    itemsCount: 1,
    lazyUpdatesCount: 1,
    committedAt: 1,
  });

  const deps = {
    session,
    nodes,
    nodeSources,
    lazyUpdates,
    items,
    extractionRuns,
    runProfileTransaction: <T>(work: () => T): T =>
      profileDb.sqlite.transaction(work)(),
  } as unknown as MemoryDeps;

  return {
    deps,
    nodes,
    nodeSources,
    lazyUpdates,
    items,
    extractionRuns,
    keptSession,
    deletedSessionId,
  };
}

describe('Memory Session 来源清理', () => {
  it('显式删除只移除或脱敏来源，保留共享 Node、Item 与待归并证据', () => {
    const h = createHarness();

    const report = cleanupSessionMemoryReferences(h.deps, h.deletedSessionId);

    expect(report).toEqual({
      nodeSourcesDeleted: 1,
      lazySourcesDetached: 1,
      itemSourcesDetached: 1,
      recoveryRunsDeleted: 1,
    });
    expect(h.nodes.findById('node-shared')).toBeDefined();
    expect(h.nodeSources.listByNode('node-shared')).toHaveLength(1);
    expect(h.nodeSources.listByNode('node-shared')[0]!.source_session_id)
      .toBe(h.keptSession.id);
    expect(h.lazyUpdates.listByNode('node-shared')[0]).toMatchObject({
      fragment: 'evidence remains useful',
      source_session_id: null,
      source_turn_id: null,
    });
    expect(h.items.findById('item-deleted')).toMatchObject({
      body: 'long-term content',
      source_session_id: null,
      source_turn_id: null,
    });
    expect(h.extractionRuns.findById('run-deleted')).toBeUndefined();
  });

  it('启动恢复只清理 Data DB 中已经不存在的 Session 来源', () => {
    const h = createHarness();

    const report = cleanupOrphanSessionMemoryReferences(h.deps);

    expect(report).toEqual({
      orphanSessions: 1,
      referencesChanged: 4,
    });
    expect(h.nodeSources.listByNode('node-shared').map(row => row.source_session_id))
      .toEqual([h.keptSession.id]);
  });
});
