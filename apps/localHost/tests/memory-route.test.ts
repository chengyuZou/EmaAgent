// 验证 Memory 面板 HTTP 边界的查询校验、会话覆盖读写和维护默认值。

import { describe, expect, it, vi } from 'vitest';
import { asSessionId } from '@ema-agent/ids';
import {
  DEFAULT_OVERRIDES,
  type MaintenanceReport,
  type MemoryStats,
} from '@ema-agent/memory';
import { memoryRoute } from '../src/routes/memory.js';

type RouteMemory = Parameters<typeof memoryRoute>[0];

const stats: MemoryStats = {
  nodes: {
    total: 1,
    byType: { user_fact: 1, entity: 0, event: 0, emotion: 0, preference: 0, relationship: 0 },
    embeddedCount: 1,
    staleEmbedCount: 0,
    avgImportance: 50,
    oldestRefAt: null,
    newestRefAt: null,
  },
  items: {
    total: 0,
    byKind: { user: 0, feedback: 0, project: 0, reference: 0 },
    embeddedCount: 0,
    staleEmbedCount: 0,
    avgImportance: 0,
  },
  edges: { total: 0, avgMentionCount: 0, maxMentionCount: 0 },
  lazyUpdates: { totalRows: 0, nodesWithPending: 0 },
  sessionNotes: { totalSessions: 0, totalChars: 0 },
  memoryTasks: { pending: 0, running: 0, completed: 0, failed: 0 },
  pendingFragments: { sessionCount: 0 },
  index: { nodes: null, items: null },
};

const maintenanceReport: MaintenanceReport = {
  dryRun: true,
  decayedNodes: 0,
  decayedItems: 0,
  preview: { nodes: [], items: [], decayedAt: 0 },
};

function createMemory(overrides: Partial<RouteMemory> = {}): RouteMemory {
  return {
    getStats: vi.fn(() => stats),
    listNodes: vi.fn(() => []),
    listItems: vi.fn(() => []),
    listEdgesForNodes: vi.fn(() => []),
    getSessionOverrides: vi.fn(() => DEFAULT_OVERRIDES),
    setSessionOverrides: vi.fn(),
    deleteNode: vi.fn(),
    deleteItem: vi.fn(),
    runMaintenance: vi.fn(() => maintenanceReport),
    ...overrides,
  };
}

describe('Memory 面板路由', () => {
  it('GET /stats 返回聚合统计', async () => {
    const app = memoryRoute(createMemory());

    const response = await app.request('/stats');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stats);
  });

  it('GET /nodes 把解析后的查询交给 Memory', async () => {
    const listNodes = vi.fn(() => []);
    const app = memoryRoute(createMemory({ listNodes }));

    const response = await app.request('/nodes?limit=5&orderBy=importance');

    expect(response.status).toBe(200);
    expect(listNodes).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, orderBy: 'importance' }),
    );
    expect(await response.json()).toEqual([]);
  });

  it('GET /nodes 查询参数越界时返回 400', async () => {
    const app = memoryRoute(createMemory());

    const response = await app.request('/nodes?limit=0');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: 'invalid_request' }),
    );
  });

  it('GET /edges 缺少 nodes 参数时不访问 Memory', async () => {
    const listEdgesForNodes = vi.fn(() => []);
    const app = memoryRoute(createMemory({ listEdgesForNodes }));

    const response = await app.request('/edges');

    expect(response.status).toBe(200);
    expect(listEdgesForNodes).not.toHaveBeenCalled();
    expect(await response.json()).toEqual([]);
  });

  it('PUT /sessions/:id/overrides 写入后返回最新覆盖', async () => {
    const setSessionOverrides = vi.fn();
    const getSessionOverrides = vi.fn(() => ({
      ...DEFAULT_OVERRIDES,
      layer2: false,
    }));
    const app = memoryRoute(createMemory({
      setSessionOverrides,
      getSessionOverrides,
    }));

    const response = await app.request('/sessions/session-1/overrides', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layer2: false }),
    });

    expect(response.status).toBe(200);
    expect(setSessionOverrides).toHaveBeenCalledWith(
      asSessionId('session-1'),
      { layer2: false },
    );
    expect(await response.json()).toEqual(
      expect.objectContaining({ layer2: false }),
    );
  });

  it('DELETE /nodes/:id 删除后返回 204', async () => {
    const deleteNode = vi.fn();
    const app = memoryRoute(createMemory({ deleteNode }));

    const response = await app.request('/nodes/node-1', { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(deleteNode).toHaveBeenCalledWith('node-1');
  });

  it('POST /maintenance 空 Body 使用默认衰减参数', async () => {
    const runMaintenance = vi.fn(() => maintenanceReport);
    const app = memoryRoute(createMemory({ runMaintenance }));

    const response = await app.request('/maintenance', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(runMaintenance).toHaveBeenCalledWith({
      decayAfterDays: 30,
      decayAmount: 10,
      decayItems: true,
      dryRun: true,
    });
    expect(await response.json()).toEqual(maintenanceReport);
  });
});
