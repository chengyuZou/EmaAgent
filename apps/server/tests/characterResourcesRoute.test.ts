// 验证主要角色资源接口等待异步 Store 操作，并向客户端返回布尔值。
import { describe, expect, it, vi } from 'vitest';
import {
  characterResourcesRoute,
  type CharacterResourcesRouteDeps,
} from '../src/routes/characters/resources.js';

describe('characterResourcesRoute', () => {
  it.each([
    ['Live2D', '/艾玛/live2d/ema/primary', 'setPrimaryLive2dModel'],
    ['插图', '/艾玛/illustrations/happy.png/primary', 'setPrimaryIllustration'],
    ['参考音频', '/艾玛/voice/sample.wav/primary', 'setPrimaryVoiceSample'],
  ] as const)('%s 主要资源接口等待 Store 并返回 boolean', async (_label, url, method) => {
    const setPrimary = vi.fn(async () => true);
    const characters = { [method]: setPrimary } as unknown as CharacterResourcesRouteDeps['characters'];
    const mutateCharacter: CharacterResourcesRouteDeps['mutateCharacter'] = async (_characterName, action) => action();
    const response = await characterResourcesRoute({ characters, mutateCharacter }).request(url, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(setPrimary).toHaveBeenCalledOnce();
  });
});
