// Settings API：/api/settings——设置目录（JSON Schema）、键值读写与 eventDisplay 合并投影。
import type { InferRequestType } from 'hono/client';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type SettingsCatalog = RpcJson<RpcClient['api']['settings']['$get']>;
export type SettingsCatalogItem = SettingsCatalog['items'][number];
export type SettingsValues = RpcJson<RpcClient['api']['settings']['values']['$get']>;
export type SettingValueEntry = SettingsValues['items'][number];
export type SettingValueResult = RpcJson<RpcClient['api']['settings']['values'][':key']['$get']>;
export type SettingsBatchEntries = InferRequestType<RpcClient['api']['settings']['values']['$put']>['json']['entries'];
export type EventDisplayTable = RpcJson<RpcClient['api']['settings']['event-display']['$get']>;

export const settingsApi = {
  /** GET /api/settings — 全量设置定义目录（含 JSON Schema，首开设置页一次拉取）。 */
  getCatalog(): Promise<SettingsCatalog> {
    return readRpcJson(rpcClient.api.settings.$get());
  },

  /** GET /api/settings/values — 全量生效值（覆盖值或默认值）。 */
  listValues(): Promise<SettingsValues> {
    return readRpcJson(rpcClient.api.settings.values.$get());
  },

  getValue(key: string): Promise<SettingValueResult> {
    return readRpcJson(rpcClient.api.settings.values[':key'].$get({ param: { key } }));
  },

  /** PUT /api/settings/values/:key — body `{ value }`。 */
  putValue<T>(key: string, value: T): Promise<SettingValueResult> {
    return readRpcJson(rpcClient.api.settings.values[':key'].$put({
      json: { value },
      param: { key },
    }));
  },

  /** PUT /api/settings/values — 批量写入（任一键非法整批拒绝）。 */
  putValues(entries: SettingsBatchEntries) {
    return readRpcJson(rpcClient.api.settings.values.$put({ json: { entries } }));
  },

  /** DELETE /api/settings/values/:key — 删即恢复默认。 */
  deleteValue(key: string) {
    return readRpcJson(rpcClient.api.settings.values[':key'].$delete({ param: { key } }));
  },

  /** GET /api/settings/event-display — 事件展示合并投影（默认表 + 用户覆盖，只读）。 */
  getEventDisplay(): Promise<EventDisplayTable> {
    return readRpcJson(rpcClient.api.settings['event-display'].$get());
  },
};
