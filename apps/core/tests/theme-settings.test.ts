// 测试 Markdown 正文字体设置的持久化、默认值和后端输入边界。
import { describe, expect, it, vi } from 'vitest';
import type { AppBindings } from '../src/wiring/index.js';
import { settingsRoute } from '../src/routes/settings.js';

function createApp(stored?: unknown) {
  const set = vi.fn();
  const app = settingsRoute({
    settings: {
      get: () => stored,
      set,
    },
  } as unknown as AppBindings);
  return { app, set };
}

describe('主题字体设置', () => {
  it('旧配置缺少字体字段时返回跨平台默认值', async () => {
    const { app } = createApp({ hue: 260, radius: 1.5, mode: 'dark' });
    const response = await app.request('/theme');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      hue: 260,
      radius: 1.5,
      mode: 'dark',
      contentFontPreset: 'system',
      contentFontFamily: '',
    });
  });

  it('允许保存单个本地字体名称', async () => {
    const { app, set } = createApp();
    const body = {
      hue: 200,
      radius: 1,
      mode: 'light',
      contentFontPreset: 'custom',
      contentFontFamily: '霞鹜文楷 LXGW WenKai',
    };
    const response = await app.request('/theme', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(set).toHaveBeenCalledWith('frontend.theme', body);
  });

  it('拒绝可拼接额外 CSS 声明的字体值', async () => {
    const { app, set } = createApp();
    const response = await app.request('/theme', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hue: 200,
        radius: 1,
        contentFontPreset: 'custom',
        contentFontFamily: "Safe Font'; position: fixed",
      }),
    });

    expect(response.status).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });
});
