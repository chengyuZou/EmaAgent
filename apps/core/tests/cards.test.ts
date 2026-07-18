import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@ema-agent/storage';
import { CharacterCardStore } from '@ema-agent/character-card';
import type { AppBindings } from '../src/wiring/index.js';
import { cardsRoute } from '../src/routes/cards.js';
import { resolveCardVoiceRefPath } from '../src/storage-locations/index.js';

// B-055:PATCH null 清空 + DELETE active 阻止。voice ref 路径安全留 Sol(需 storage-locations)。
describe('B-055 cards route', () => {
  let db: Database;
  let card: CharacterCardStore;
  let app: ReturnType<typeof cardsRoute>;

  beforeEach(() => {
    db = new Database({ memory: true, kind: 'profile' });
    db.migrate();
    card = new CharacterCardStore({ db });
    app = cardsRoute({ card } as unknown as AppBindings);
  });

  afterEach(() => db.close());

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
    const res = await app.request(`/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('POST 创建卡时 refAudioPath 越界被拒 400(B-055)', async () => {
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
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_voice_ref_path' });
  });

  it('GET voice-ref 遇到库中构造的越界路径返回 400 而不是文件内容(B-055)', async () => {
    // 绕过路由校验, 直接在库里放构造的卡(模拟 DB 被篡改)。
    const created = card.create({
      name: 'Crafted',
      systemPrompt: 'p',
      voiceProfile: {
        refAudios: [{
          id: 'ra_crafted',
          label: 'crafted',
          refAudioPath: 'voiceRefs/../../../package.json',
          promptText: 'x',
          promptLang: 'zh',
        }],
        primaryId: 'ra_crafted',
      },
    });
    const res = await app.request(`/${created.id}/voice-refs/ra_crafted`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_voice_ref_path' });
  });

  it('resolveCardVoiceRefPath 自身只放行 voiceRefs/ 单层文件名', () => {
    expect(() => resolveCardVoiceRefPath('c', false, 'voiceRefs/ra_a.mp3')).not.toThrow();
    expect(() => resolveCardVoiceRefPath('c', false, 'voiceRefs/../../etc/passwd')).toThrow(/invalid_voice_ref_path/);
  });
});
