import { describe, expect, it } from 'vitest';
import type { AppBindings, ReleaseFeaturesWire } from '../src/wiring/index.js';
import { systemRoute } from '../src/routes/system.js';

// V1 Artifact 撤出:capabilities 端点是前端 fail-closed 的唯一事实来源。
// 这里只测 systemRoute(/api/system/capabilities)——/api/artifacts 的 404
// 由 server.ts 的 `if (bindings.releaseFeatures.artifacts)` 条件挂载结构性地保证,
// 不在此重复(全量 buildServer 集成测试开销过大且与单测目的不符)。
function buildApp(releaseFeatures: ReleaseFeaturesWire): ReturnType<typeof systemRoute> {
  return systemRoute({ releaseFeatures } as unknown as AppBindings);
}

describe('V1 发布特性开关 (/api/system/capabilities)', () => {
  it('V1 默认:artifacts=false', async () => {
    const app = buildApp({ artifacts: false });
    const res = await app.request('/capabilities');
    expect(res.status).toBe(200);
    const body = await res.json() as { release: string; features: { artifacts: boolean } };
    expect(body.release).toBe('v1');
    expect(body.features.artifacts).toBe(false);
  });

  it('artifacts=true 时如实透传(V1.5 接线后)', async () => {
    const app = buildApp({ artifacts: true });
    const res = await app.request('/capabilities');
    expect(res.status).toBe(200);
    const body = await res.json() as { features: { artifacts: boolean } };
    expect(body.features.artifacts).toBe(true);
  });
});
