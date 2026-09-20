// 验证库列表和激活事实在写入成功后广播, 让设置窗口之外的 Chat 能重新读取.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { KnowledgeEvent } from '@ema-agent/knowledge';
import { knowledgeLibsRoute } from '../src/routes/knowledge/libs.js';

describe('knowledge library events', () => {
  it('创建、改名和删除刷新其他窗口的库列表, 删除激活库还通知新激活状态', async () => {
    const events: KnowledgeEvent[] = [];
    const libraries = new Map<string, { id: string; name: string }>();
    let activeId: string | null = null;
    const kb = {
      listKbSummaries: () => [...libraries.values()],
      getKb: (id: string) => libraries.get(id),
      getActiveKb: () => activeId ? libraries.get(activeId) : undefined,
      createKb: async (name: string) => {
        const library = { id: 'lib-1', name };
        libraries.set(library.id, library);
        return library;
      },
      renameKb: (id: string, name: string) => {
        libraries.set(id, { id, name });
      },
      setActiveKb: (id: string) => {
        if (!libraries.has(id)) return false;
        activeId = id;
        return true;
      },
      unregisterKb: async (id: string) => {
        libraries.delete(id);
        if (activeId === id) activeId = null;
      },
    };
    const app = new Hono().route('/api/knowledge', knowledgeLibsRoute({
      kb: kb as never,
      providerModels: { get: () => undefined } as never,
      emit: event => events.push(event),
    }));

    expect((await app.request('/api/knowledge/libs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '第一库', path: 'D:/knowledge' }),
    })).status).toBe(201);
    expect((await app.request('/api/knowledge/libs/lib-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '已改名' }),
    })).status).toBe(200);
    expect((await app.request('/api/knowledge/libs/lib-1/activate', {
      method: 'POST',
    })).status).toBe(200);
    expect((await app.request('/api/knowledge/libs/lib-1', {
      method: 'DELETE',
    })).status).toBe(200);
    expect(events).toEqual([
      { type: 'kb_library_list_changed' },
      { type: 'kb_library_list_changed' },
      { type: 'kb_active_changed', kbId: 'lib-1' },
      { type: 'kb_library_list_changed' },
      { type: 'kb_active_changed', kbId: null },
    ]);
  });
});
