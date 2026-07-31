// 测试角色卡 Route 的空值更新、删除守卫与参考音频路径安全。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@ema-agent/storage';
import { CharacterCardStore } from '@ema-agent/characters';
import { asCharacterCardId, asCharacterVoiceReferenceId } from '@ema-agent/ids';
import { cardsRoute } from '../src/routes/cards.js';

describe('B-055 cards route', () => {
  let db: Database;
  let card: CharacterCardStore;
  let app: ReturnType<typeof cardsRoute>;
  let resourceRoot: string;

  beforeEach(() => {
    db = new Database({ memory: true, kind: 'profile' });
    db.migrate();
    resourceRoot = mkdtempSync(join(tmpdir(), 'ema-cards-route-'));
    card = new CharacterCardStore({
      db,
      resourceRoots: {
        builtinCardsRoot: join(resourceRoot, 'builtin'),
        userCardsRoot: join(resourceRoot, 'user'),
      },
    });
    app = cardsRoute(card, {
      resolve: fileHandle => fileHandle,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(resourceRoot, { recursive: true, force: true });
  });

  async function createCard(name: string): Promise<{ id: string }> {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, systemPrompt: 'p' }),
    });
    return await res.json() as { id: string };
  }

  it('PATCH description=null 清空字段(不再被 ?? undefined 转成不更新)', async () => {
    const { id } = await createCard('Test');
    // 先设非空
    await app.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'desc' }),
    });
    // 清空
    const res = await app.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: null }),
    });
    const updated = await res.json() as { description: string | null };
    expect(updated.description).toBeNull();
  });

  it('DELETE active 卡被拒 409(避免零 active)', async () => {
    const { id } = await createCard('Active');
    await app.request(`/${id}/activate`, { method: 'PUT' });
    const res = await app.request(`/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(card.get(id as never)).toBeDefined();   // 未删
  });

  it('DELETE 非 active 用户卡成功 204', async () => {
    const { id } = await createCard('Tmp');
    const cardDirectory = join(resourceRoot, 'user', id);
    mkdirSync(cardDirectory, { recursive: true });
    writeFileSync(join(cardDirectory, 'marker.txt'), 'managed');
    const res = await app.request(`/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(card.get(id as never)).toBeUndefined();
    expect(() => writeFileSync(join(cardDirectory, 'still-there.txt'), 'x'))
      .toThrow();
  });

  it('健康接口投影降级资源，空 Prompt 角色不能激活', async () => {
    const { id } = await createCard('Health');
    const healthResponse = await app.request(`/${id}/health`);
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({
      characterId: id,
      status: 'degraded',
      executionAvailable: true,
      presentation: 'placeholder',
    });

    db.sqlite.prepare(
      'UPDATE character_cards SET system_prompt = ? WHERE id = ?',
    ).run(' ', id);
    const activateResponse = await app.request(`/${id}/activate`, {
      method: 'PUT',
    });
    expect(activateResponse.status).toBe(409);
    await expect(activateResponse.json()).resolves.toMatchObject({
      error: 'character_not_executable',
      health: {
        executionAvailable: false,
        status: 'invalid',
      },
    });
  });

  it('表现快照按主资源顺序返回候选，并允许运行中切换主 Live2D', async () => {
    const created = card.create({ name: 'Stage', systemPrompt: 'p' });
    const live2dDir = join(resourceRoot, 'user', created.id, 'live2d');
    mkdirSync(live2dDir, { recursive: true });
    writeFileSync(join(live2dDir, 'a.model3.json'), '{}');
    writeFileSync(join(live2dDir, 'b.model3.json'), '{}');
    const first = card.addLive2dVariant(created.id, {
      label: 'A',
      format: 'live2d',
      entryPath: 'live2d/a.model3.json',
      position: 0,
      isPrimary: true,
    });
    const second = card.addLive2dVariant(created.id, {
      label: 'B',
      format: 'live2d',
      entryPath: 'live2d/b.model3.json',
      position: 1,
    });

    const switchResponse = await app.request(`/${created.id}/live2d/primary`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId: second.id }),
    });
    expect(switchResponse.status).toBe(200);

    const response = await app.request(`/${created.id}/presentation`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      characterId: created.id,
      candidates: [
        {
          kind: 'live2d',
          resourceId: second.id,
          sourcePath: join(live2dDir, 'b.model3.json'),
        },
        {
          kind: 'live2d',
          resourceId: first.id,
          sourcePath: join(live2dDir, 'a.model3.json'),
        },
      ],
    });
  });

  it('POST 不再接受旧 voiceProfile JSON 事实源', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Evil',
        systemPrompt: 'p',
        voiceProfile: {
          refAudios: [{
            id: 'ra_evil',
            label: 'evil',
            refAudioPath: 'voiceRefs/../../etc/passwd',
            promptText: 'x',
            promptLang: 'zh',
          }],
          primaryId: 'ra_evil',
        },
      }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_request' });
  });

  it('GET voice-ref 遇到库中构造的越界路径返回 400 而不是文件内容(B-055)', async () => {
    // 绕过路由校验, 直接在库里放构造的卡(模拟 DB 被篡改)。
    const created = card.create({
      name: 'Crafted',
      systemPrompt: 'p',
    });
    card.addVoiceReference(created.id, {
      id: asCharacterVoiceReferenceId('ra_crafted'),
      label: 'crafted',
      relativePath: 'voiceRefs/crafted.mp3',
      promptText: 'x',
      promptLang: 'zh',
      mimeType: 'audio/mpeg',
      isPrimary: true,
    });
    db.sqlite.prepare(
      'UPDATE character_voice_references SET relative_path = ? WHERE id = ?',
    ).run('voiceRefs/../../../package.json', 'ra_crafted');
    const res = await app.request(`/${created.id}/voice-refs/ra_crafted`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_voice_ref_path' });
  });

  it('Character 领域只放行 voiceRefs/ 单层文件名', async () => {
    const { id } = await createCard('Path owner');
    expect(() => card.resolveResourcePath(
      asCharacterCardId(id),
      'voiceRefs/ra_a.mp3',
      'voiceReference',
    )).not.toThrow();
    expect(() => card.resolveResourcePath(
      asCharacterCardId(id),
      'voiceRefs/../../etc/passwd',
      'voiceReference',
    )).toThrow(/invalid character resource path/);
  });

  it('C3b 资源 Route 只消费授权句柄并完成立绘导入导出删除', async () => {
    const { id } = await createCard('Portrait API');
    const source = join(resourceRoot, 'source.png');
    writeFileSync(source, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ));
    const importResponse = await app.request(`/${id}/portraits/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceHandle: source,
        label: 'Standing',
      }),
    });
    expect(importResponse.status).toBe(201);
    const imported = await importResponse.json() as {
      resource: { id: string; relativePath: string };
    };

    const destination = join(resourceRoot, 'exports');
    mkdirSync(destination);
    const exportResponse = await app.request(
      `/${id}/portraits/${imported.resource.id}/export`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationHandle: destination }),
      },
    );
    expect(exportResponse.status).toBe(200);
    const exported = await exportResponse.json() as { destinationPath: string };
    expect(existsSync(exported.destinationPath)).toBe(true);

    const deleteResponse = await app.request(
      `/${id}/portraits/${imported.resource.id}`,
      { method: 'DELETE' },
    );
    expect(deleteResponse.status).toBe(204);
    expect(card.get(asCharacterCardId(id))?.portraits).toHaveLength(0);
  });
});
