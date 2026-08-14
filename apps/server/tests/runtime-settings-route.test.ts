// 测试事件通知与权限等待设置的默认协议、输入边界和运行时即时更新。
import { describe, expect, it, vi } from 'vitest';
import { agentSetting } from '@ema-agent/agent';
import { SettingsCatalog, SettingsStore } from '@ema-agent/settings';
import { settingsRoute } from '../src/routes/settings.js';

function createApp(stored: Record<string, unknown> = {}) {
  const set = vi.fn();
  const setDefaultTimeout = vi.fn();
  const settings = new SettingsStore({
    read: key => key in stored
      ? { status: 'found', value: stored[key] }
      : { status: 'missing' },
    set: (key, value) => {
      set(key, value);
      stored[key] = value;
    },
    setMany: () => {},
    delete: () => {},
  });
  const catalog = new SettingsCatalog([agentSetting]);
  const app = settingsRoute({
    settings,
    catalog,
    setDefaultPermissionTimeout: setDefaultTimeout,
  });
  return { app, set, setDefaultTimeout };
}

describe('运行时设置路由', () => {
  it('事件默认值使用当前结构化事件名，不再返回旧别名', async () => {
    const { app } = createApp();
    const response = await app.request('/event-display');
    const body = await response.json() as { defaults: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.defaults).toHaveProperty('context_compaction_completed');
    expect(body.defaults).toHaveProperty('memory_recall_evidence');
    expect(body.defaults).toHaveProperty('memory_task_failed');
    expect(body.defaults).not.toHaveProperty('context_compacted');
    expect(body.defaults).not.toHaveProperty('recall_evidence');
    expect(body.defaults).not.toHaveProperty('background_task_failed');
  });

  it('拒绝不可用颜色和负数停留时间', async () => {
    const { app, set } = createApp();
    const response = await app.request('/event-display', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_warning: { enabled: true, color: 'url(file:///secret)', durationMs: -1 },
      }),
    });

    expect(response.status).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  it('读取旧事件别名时迁移到当前协议名并丢弃损坏配置', async () => {
    const { app } = createApp({
      'frontend.eventDisplay': {
        context_compacted: { enabled: false, color: '#123456', durationMs: 2000 },
        background_task_failed: { enabled: true, color: '#ef4444', durationMs: 4000 },
        broken: { enabled: true, color: 'not-a-color', durationMs: -1 },
      },
    });
    const response = await app.request('/event-display');
    const body = await response.json() as { overrides: Record<string, unknown> };

    expect(body.overrides).toHaveProperty('context_compaction_completed');
    expect(body.overrides).toHaveProperty('memory_task_failed');
    expect(body.overrides).not.toHaveProperty('context_compacted');
    expect(body.overrides).not.toHaveProperty('background_task_failed');
    expect(body.overrides).not.toHaveProperty('broken');
  });

  it('权限等待时间保存后立即更新 Permission Registry 默认值', async () => {
    const { app, set, setDefaultTimeout } = createApp();
    const response = await app.request('/permission-timeout', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeoutMs: 45_000 }),
    });

    expect(response.status).toBe(200);
    expect(set).toHaveBeenCalledWith('permission.askTimeoutMs', 45_000);
    expect(setDefaultTimeout).toHaveBeenCalledWith(45_000);
  });

  it('权限等待时间限制在 5 秒到 10 分钟', async () => {
    const { app, setDefaultTimeout } = createApp();
    const response = await app.request('/permission-timeout', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeoutMs: 601_000 }),
    });

    expect(response.status).toBe(400);
    expect(setDefaultTimeout).not.toHaveBeenCalled();
  });

  it('通用入口按业务定义读取默认值并返回生效时机', async () => {
    const { app } = createApp();
    const response = await app.request('/values/agent.limits');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      key: 'agent.limits',
      apply: 'nextTurn',
      value: {
        chatMaxIterations: 8,
        workMaxIterations: 30,
      },
    });
  });

  it('通用入口先按业务定义校验，非法值不会写入 SQLite', async () => {
    const { app, set } = createApp();
    const response = await app.request('/values/agent.limits', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        value: {
          chatMaxIterations: 0,
          workMaxIterations: 30,
          maxToolCalls: 256,
          maxSubagents: 16,
          maxConcurrentSubagents: 4,
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });
});
