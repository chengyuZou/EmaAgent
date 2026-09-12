// 验证角色资料只在修改舞台类型时使用 Session 门禁。
import { describe, expect, it, vi } from 'vitest';
import {
  characterCollectionRoute,
  type CharacterCollectionRouteDeps,
} from '../src/routes/characters/collection.js';

function fixture() {
  const characters = {
    update: vi.fn((_name: string, patch: unknown) => ({ name: '艾玛', patch })),
  } as unknown as CharacterCollectionRouteDeps['characters'];
  const runWhenSessionsIdle: CharacterCollectionRouteDeps['runWhenSessionsIdle'] = vi.fn(async action => action());
  return {
    characters,
    runWhenSessionsIdle,
    activateCharacter: vi.fn(async () => undefined),
    deleteCharacter: vi.fn(async () => undefined),
  };
}

describe('characterCollectionRoute', () => {
  it('显示名、描述和 Persona Prompt 不经过 Session 门禁', async () => {
    const deps = fixture();
    const response = await characterCollectionRoute(deps).request('/艾玛', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: '樱羽艾玛',
        description: '桌面助手',
        personaPrompt: '你是艾玛。',
      }),
    });

    expect(response.status).toBe(200);
    expect(deps.characters.update).toHaveBeenCalledOnce();
    expect(deps.runWhenSessionsIdle).not.toHaveBeenCalled();
  });

  it('修改舞台类型经过 Session 门禁', async () => {
    const deps = fixture();
    const response = await characterCollectionRoute(deps).request('/艾玛', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageKind: 'illustration' }),
    });

    expect(response.status).toBe(200);
    expect(deps.runWhenSessionsIdle).toHaveBeenCalledOnce();
    expect(deps.characters.update).toHaveBeenCalledOnce();
  });

  it('切换和删除请求不再接收强制终止字段', async () => {
    const deps = fixture();
    const activate = await characterCollectionRoute(deps).request('/艾玛/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terminateRunningWork: true }),
    });
    const remove = await characterCollectionRoute(deps).request('/艾玛', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terminateRunningWork: true }),
    });

    expect(activate.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(deps.activateCharacter).toHaveBeenCalledWith('艾玛');
    expect(deps.deleteCharacter).toHaveBeenCalledWith('艾玛');
  });
});
