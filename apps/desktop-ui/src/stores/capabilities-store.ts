/**
 * Capabilities store — V1 发布特性开关(前端镜像)。
 *
 * 启动时拉一次 GET /api/system/capabilities,fail-closed:
 * 未加载 / 请求失败 / 字段缺失 → artifacts=false。
 * 组件据 `features.artifacts` 决定是否显示 Artifact 等未完成功能入口。
 */
import { create } from 'zustand';
import { systemApi, FEATURES_DISABLED } from '../api/system.js';
import type { ReleaseFeaturesWire } from '@ema-agent/system';

export interface CapabilitiesStoreState {
  /** 当前生效的特性集。加载前为 FEATURES_DISABLED(fail-closed)。 */
  features:  ReleaseFeaturesWire;
  /** 是否已成功拉取过一次(区分"还没加载"与"加载到全 false")。 */
  loaded:    boolean;
  /** 拉取 capabilities。幂等,失败不抛(fail-closed 写回 FEATURES_DISABLED)。 */
  load(): Promise<void>;
}

export const useCapabilitiesStore = create<CapabilitiesStoreState>((set) => ({
  features: FEATURES_DISABLED,
  loaded:   false,

  async load() {
    const body = await systemApi.getCapabilities();
    set({ features: body.features, loaded: true });
  },
}));
