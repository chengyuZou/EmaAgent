import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildComposition, type Composition } from '../src/composition/index.js';
import { createRoutes } from '../src/routes/index.js';
import { ensureDataDirLayout, ensureProfileLayout } from '../src/platform/paths.js';

describe('KB 全链路移除', () => {
  it('真实路由返回 KB 404, 保留 Session/设置并不创建默认 KB', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-no-kb-'));
    const previousProfile = process.env['EMA_PROFILE_DIR'];
    process.env['EMA_PROFILE_DIR'] = profile;
    let composition: Composition | undefined;
    try {
      ensureProfileLayout();
      ensureDataDirLayout(path.join(profile, 'data'));
      composition = buildComposition({
        activeDataDir: path.join(profile, 'data'),
        initializeBuiltinCharacters: true,
      });
      await composition.tools.skillStore.sweepOrphanStaging();
      await composition.tools.skills.refreshCore();
      const secret = 'kb-removal-route-test-secret-000000000';
      const app = createRoutes(composition, secret);
      const headers = { 'X-Ema-Secret': secret };
      for (const route of ['/api/kb/libs', '/api/kb/test/documents', '/api/kb/test/search']) {
        const response = await app.request(route, { headers });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'not_found' });
      }
      const sessions = await app.request('/api/sessions', { headers });
      expect(sessions.status).toBe(200);
      const settings = await app.request('/api/settings/values', { headers });
      expect(settings.status).toBe(200);
      const values = await settings.json() as { items: Array<{ key: string }> };
      expect(values.items.some(item => item.key.startsWith('kb.'))).toBe(false);
      expect(fs.existsSync(path.join(profile, 'kb'))).toBe(false);
      expect(app.routes.some(route => route.path.startsWith('/api/kb'))).toBe(false);
    } finally {
      await composition?.close();
      if (previousProfile === undefined) {
        delete process.env['EMA_PROFILE_DIR'];
      } else {
        process.env['EMA_PROFILE_DIR'] = previousProfile;
      }
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
});
