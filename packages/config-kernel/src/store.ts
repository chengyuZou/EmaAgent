/**
 * 配置持久化存储接口。
 */

/** 配置存储抽象 */
export interface ConfigStore {
  /** 读取指定层配置 */
  read(layer: string): Promise<unknown>;
  /** 写入指定层配置 */
  write(layer: string, data: unknown): Promise<void>;
}

let storeInstance: ConfigStore | null = null;

/**
 * 获取全局配置存储实例（懒加载）。
 *
 * @throws {Error} 如果尚未注册存储实现
 */
export function getConfigStore(): ConfigStore {
  if (!storeInstance) {
    throw new Error("ConfigStore not registered. Call setConfigStore() first.");
  }
  return storeInstance;
}

/**
 * 注册配置存储实现（应在应用启动时调用一次）。
 */
export function setConfigStore(store: ConfigStore): void {
  storeInstance = store;
}

/**
 * 保存指定层配置。
 *
 * @param layer - 配置层名称，如 "user" | "session:{id}"
 * @param data - 配置数据
 */
export async function saveConfigLayer(layer: string, data: unknown): Promise<void> {
  const store = getConfigStore();
  await store.write(layer, data);
}
