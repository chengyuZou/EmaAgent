import { CharacterPromptInvalidError } from '@ema-agent/characters';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  characterResourcesRoute,
  type CharacterResourcesRouteDeps,
} from '../src/routes/characters/resources.js';

function fixture() {
  const characters = {
    live2dModels: {
      setPrimary: vi.fn(async () => true),
      prepareImport: vi.fn(async () => ({
        importId: 'prepared-1',
        name: 'Hiyori',
        displayName: 'Hiyori',
        byteSize: 4096,
      })),
      streamPreparedArchive: vi.fn(() => Readable.from([Buffer.from('archive')])),
      commitImport: vi.fn(async () => ({ name: 'Hiyori' })),
      cancelImport: vi.fn(async () => undefined),
      delete: vi.fn(async () => true),
    },
    illustrations: {
      setPrimary: vi.fn(async () => true),
      delete: vi.fn(async () => true),
    },
    voiceSamples: {
      setPrimary: vi.fn(async () => true),
      update: vi.fn(async () => ({ name: 'sample.wav' })),
      delete: vi.fn(async () => true),
    },
    stickers: {
      import: vi.fn(async () => ({ name: 'hello.png', description: '' })),
      update: vi.fn(async () => ({ name: 'hello.png', description: '挥手.' })),
      delete: vi.fn(async () => undefined),
    },
  } as unknown as CharacterResourcesRouteDeps['characters'];
  const runWhenSessionsIdle: CharacterResourcesRouteDeps['runWhenSessionsIdle'] = vi.fn(async action => action());
  return { characters, runWhenSessionsIdle };
}

describe('characterResourcesRoute', () => {
  it('表情包允许清空描述, 且保存失败会返回可显示的原因', async () => {
    const deps = fixture();
    const route = characterResourcesRoute(deps);
    const response = await route.request('/艾玛/stickers/hello.png', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '  开心  ', description: '' }),
    });
    expect(response.status).toBe(200);
    expect(deps.characters.stickers.update).toHaveBeenCalledWith('艾玛', 'hello.png', {
      displayName: '开心', description: '',
    });
    expect(deps.runWhenSessionsIdle).toHaveBeenCalledOnce();

    vi.mocked(deps.characters.stickers.update).mockRejectedValueOnce(
      new CharacterPromptInvalidError('表情包说明超过上限'),
    );
    const rejected = await route.request('/艾玛/stickers/hello.png', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '开心', description: '挥手.' }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ message: '表情包说明超过上限' });
  });

  it('参考音频允许只更新朗读文本和语言, 并规范化首尾空白', async () => {
    const deps = fixture();
    const response = await characterResourcesRoute(deps).request('/艾玛/voice/sample.wav', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promptText: '  Corrected transcript.  ', promptLang: ' en ' }),
    });

    expect(response.status).toBe(200);
    expect(deps.characters.voiceSamples.update).toHaveBeenCalledWith('艾玛', 'sample.wav', {
      promptText: 'Corrected transcript.',
      promptLang: 'en',
    });
  });

  it.each([
    ['空白文本', { promptText: '   ' }],
    ['空白语言', { promptLang: '   ' }],
    ['文本过长', { promptText: 'a'.repeat(4_001) }],
    ['语言过长', { promptLang: 'a'.repeat(33) }],
  ] as const)('拒绝无效的参考音频文本或语言: %s', async (_label, patch) => {
    const deps = fixture();
    const response = await characterResourcesRoute(deps).request('/艾玛/voice/sample.wav', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });

    expect(response.status).toBe(400);
    expect(deps.characters.voiceSamples.update).not.toHaveBeenCalled();
  });

  it.each([
    ['Live2D', '/艾玛/live2d/ema/primary', 'live2dModels', true],
    ['插图', '/艾玛/illustrations/happy.png/primary', 'illustrations', false],
    ['参考音频', '/艾玛/voice/sample.wav/primary', 'voiceSamples', true],
  ] as const)('%s 主要资源接口使用正确的 Session 规则', async (_label, url, method, gated) => {
    const deps = fixture();
    const response = await characterResourcesRoute(deps).request(url, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(deps.characters[method].setPrimary).toHaveBeenCalledOnce();
    expect(deps.runWhenSessionsIdle).toHaveBeenCalledTimes(gated ? 1 : 0);
  });

  it('Live2D 暂存导入、读取、提交与取消都不经过 Session 门禁', async () => {
    const deps = fixture();
    const route = characterResourcesRoute(deps);
    const preparedResponse = await route.request('/艾玛/live2d/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'D:/Hiyori' }),
    });
    const archiveResponse = await route.request('/艾玛/live2d/imports/prepared-1/archive');
    const committedResponse = await route.request('/艾玛/live2d/imports/prepared-1/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ previewPngBase64: 'iVBORw0KGgo=' }),
    });
    const cancelledResponse = await route.request('/艾玛/live2d/imports/prepared-1', {
      method: 'DELETE',
    });

    expect(preparedResponse.status).toBe(200);
    expect(await preparedResponse.json()).toMatchObject({ importId: 'prepared-1', name: 'Hiyori' });
    expect(archiveResponse.status).toBe(200);
    expect(await archiveResponse.text()).toBe('archive');
    expect(committedResponse.status).toBe(200);
    expect(await committedResponse.json()).toEqual({ name: 'Hiyori' });
    expect(cancelledResponse.status).toBe(200);
    expect(await cancelledResponse.json()).toEqual({ ok: true });
    expect(deps.characters.live2dModels.prepareImport).toHaveBeenCalledWith('艾玛', { source: 'D:/Hiyori' });
    expect(deps.characters.live2dModels.streamPreparedArchive).toHaveBeenCalledWith('艾玛', 'prepared-1');
    expect(deps.characters.live2dModels.commitImport).toHaveBeenCalledWith(
      '艾玛',
      'prepared-1',
      Buffer.from('iVBORw0KGgo=', 'base64'),
    );
    expect(deps.characters.live2dModels.cancelImport).toHaveBeenCalledWith('艾玛', 'prepared-1');
    expect(deps.runWhenSessionsIdle).not.toHaveBeenCalled();
  });

  it('旧的单步 Live2D 导入入口已经移除', async () => {
    const response = await characterResourcesRoute(fixture()).request('/艾玛/live2d/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'D:/Hiyori' }),
    });

    expect(response.status).toBe(404);
  });

  it.each([
    ['Live2D', '/艾玛/live2d/ema', 'live2dModels'],
    ['插图', '/艾玛/illustrations/happy.png', 'illustrations'],
    ['参考音频', '/艾玛/voice/sample.wav', 'voiceSamples'],
  ] as const)('删除任意%s资源都经过 Session 门禁', async (_label, url, method) => {
    const deps = fixture();
    const response = await characterResourcesRoute(deps).request(url, { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(deps.runWhenSessionsIdle).toHaveBeenCalledOnce();
    expect(deps.characters[method].delete).toHaveBeenCalledOnce();
  });
});
