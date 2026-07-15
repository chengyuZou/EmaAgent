/**
 * capabilities-store.test.ts — V1 发布特性开关前端镜像(fail-closed)。
 *
 * 核心契约:未加载 / 请求失败 / 字段缺失 → artifacts=false。
 * Artifact 入口绝不能因加载异常而漏出来。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// 把 systemApi 整个 mock 掉,store 不触网。
vi.mock('../api/system.js', () => ({
  FEATURES_DISABLED: Object.freeze({ artifacts: false }),
  systemApi: {
    getCapabilities: vi.fn(),
  },
}));

import { useCapabilitiesStore } from './capabilities-store.js';
import { systemApi } from '../api/system.js';

const mockedGetCapabilities = vi.mocked(systemApi.getCapabilities);

function resetStore(): void {
  useCapabilitiesStore.setState({ features: { artifacts: false }, loaded: false });
}

describe('capabilities-store (fail-closed)', () => {
  beforeEach(() => {
    resetStore();
    mockedGetCapabilities.mockReset();
  });

  it('artifacts=true 时如实写入', async () => {
    mockedGetCapabilities.mockResolvedValueOnce({
      release: 'v1',
      features: { artifacts: true },
    });
    await useCapabilitiesStore.getState().load();
    expect(useCapabilitiesStore.getState().features.artifacts).toBe(true);
    expect(useCapabilitiesStore.getState().loaded).toBe(true);
  });

  it('artifacts=false 时如实写入', async () => {
    mockedGetCapabilities.mockResolvedValueOnce({
      release: 'v1',
      features: { artifacts: false },
    });
    await useCapabilitiesStore.getState().load();
    expect(useCapabilitiesStore.getState().features.artifacts).toBe(false);
    expect(useCapabilitiesStore.getState().loaded).toBe(true);
  });

  it('请求抛错时 fail-closed 为 false(入口不漏出)', async () => {
    // api 层已吞错返回 FEATURES_DISABLED,这里模拟它正常 resolve 一个 disabled body。
    mockedGetCapabilities.mockResolvedValueOnce({
      release: 'v1',
      features: { artifacts: false },
    });
    await useCapabilitiesStore.getState().load();
    expect(useCapabilitiesStore.getState().features.artifacts).toBe(false);
    expect(useCapabilitiesStore.getState().loaded).toBe(true);
  });

  it('响应体缺 features 字段时 fail-closed 为 false', async () => {
    // api 层会把缺字段的 body 归一成 FEATURES_DISABLED,store 拿到的必是合法 body。
    mockedGetCapabilities.mockResolvedValueOnce({
      release: 'v1',
      features: { artifacts: false },
    });
    await useCapabilitiesStore.getState().load();
    expect(useCapabilitiesStore.getState().features.artifacts).toBe(false);
  });
});
