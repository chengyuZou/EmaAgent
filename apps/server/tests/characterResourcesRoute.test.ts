// 验证角色资源路由只对会替换正式主资源的写入和删除启用 Session 门禁。
import { describe, expect, it, vi } from 'vitest';
import {
  characterResourcesRoute,
  type CharacterResourcesRouteDeps,
} from '../src/routes/characters/resources.js';

function fixture() {
  const characters = {
    setPrimaryLive2dModel: vi.fn(async () => true),
    setPrimaryIllustration: vi.fn(async () => true),
    setPrimaryVoiceSample: vi.fn(async () => true),
    importLive2dModel: vi.fn(async () => ({ name: 'imported' })),
    deleteLive2dModel: vi.fn(async () => true),
    deleteIllustration: vi.fn(async () => true),
    deleteVoiceSample: vi.fn(async () => true),
  } as unknown as CharacterResourcesRouteDeps['characters'];
  const runWhenSessionsIdle: CharacterResourcesRouteDeps['runWhenSessionsIdle'] = vi.fn(async action => action());
  return { characters, runWhenSessionsIdle };
}

describe('characterResourcesRoute', () => {
  it.each([
    ['Live2D', '/艾玛/live2d/ema/primary', 'setPrimaryLive2dModel', true],
    ['插图', '/艾玛/illustrations/happy.png/primary', 'setPrimaryIllustration', false],
    ['参考音频', '/艾玛/voice/sample.wav/primary', 'setPrimaryVoiceSample', true],
  ] as const)('%s 主要资源接口使用正确的 Session 规则', async (_label, url, method, gated) => {
    const deps = fixture();
    const response = await characterResourcesRoute(deps).request(url, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(deps.characters[method]).toHaveBeenCalledOnce();
    expect(deps.runWhenSessionsIdle).toHaveBeenCalledTimes(gated ? 1 : 0);
  });

  it('导入 Live2D 不经过门禁，且请求不能顺便设为主要模型', async () => {
    const deps = fixture();
    const response = await characterResourcesRoute(deps).request('/艾玛/live2d/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'D:/Hiyori', isPrimary: true }),
    });

    expect(response.status).toBe(400);
    expect(deps.characters.importLive2dModel).not.toHaveBeenCalled();
    expect(deps.runWhenSessionsIdle).not.toHaveBeenCalled();
  });

  it.each([
    ['Live2D', '/艾玛/live2d/ema', 'deleteLive2dModel'],
    ['插图', '/艾玛/illustrations/happy.png', 'deleteIllustration'],
    ['参考音频', '/艾玛/voice/sample.wav', 'deleteVoiceSample'],
  ] as const)('删除任意%s资源都经过 Session 门禁', async (_label, url, method) => {
    const deps = fixture();
    const response = await characterResourcesRoute(deps).request(url, { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(deps.runWhenSessionsIdle).toHaveBeenCalledOnce();
    expect(deps.characters[method]).toHaveBeenCalledOnce();
  });
});
