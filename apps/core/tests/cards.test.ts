import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@ema-agent/storage';
import { CharacterCardStore } from '@ema-agent/character-card';
import type { AppBindings } from '../src/wiring/index.js';
import { cardsRoute } from '../src/routes/cards.js';

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
});
