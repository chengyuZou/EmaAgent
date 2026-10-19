import type { InferRequestType } from 'hono/client';
import type { SettingDefinition } from '@ema-agent/server/settings';
import { rpcClient, readRpcJson, type RpcClient, type RpcJson } from './client.js';

export type SettingsValues = RpcJson<RpcClient['api']['settings']['values']['$get']>;
export type SettingValueEntry = SettingsValues['items'][number];
export type SettingApply = SettingValueEntry['apply'];
export type SettingValueResult = RpcJson<RpcClient['api']['settings']['values'][':key']['$get']>;
export type TypedSettingValue<T> = Omit<SettingValueResult, 'value'> & { value: T };
export type SettingsBatchEntries = InferRequestType<RpcClient['api']['settings']['values']['$put']>['json']['entries'];
export type EventDisplayTable = RpcJson<RpcClient['api']['settings']['event-display']['$get']>;

export const settingsApi = {
  /** 返回用户覆盖后的生效值, 未覆盖项使用默认值. */
  listValues(): Promise<SettingsValues> {
    return readRpcJson(rpcClient.api.settings.values.$get());
  },

  async getValue<T>(definition: SettingDefinition<T>): Promise<TypedSettingValue<T>> {
    const result = await readRpcJson(rpcClient.api.settings.values[':key'].$get({ param: { key: definition.key } }));
    return { ...result, value: definition.schema.parse(result.value) };
  },

  /** PUT /api/settings/values/:key  -  body `{ value }`. */
  async putValue<T>(definition: SettingDefinition<T>, value: NoInfer<T>): Promise<TypedSettingValue<T>> {
    const result = await readRpcJson(rpcClient.api.settings.values[':key'].$put({
      json: { value },
      param: { key: definition.key },
    }));
    return { ...result, value: definition.schema.parse(result.value) };
  },

  /** 任一键非法时整批拒绝, 不保存部分设置. */
  putValues(entries: SettingsBatchEntries) {
    return readRpcJson(rpcClient.api.settings.values.$put({ json: { entries } }));
  },

  /** 删除覆盖值后恢复默认设置. */
  deleteValue(definition: SettingDefinition<unknown>) {
    return readRpcJson(rpcClient.api.settings.values[':key'].$delete({ param: { key: definition.key } }));
  },

  /** 返回默认表与用户覆盖合并后的事件展示设置. */
  getEventDisplay(): Promise<EventDisplayTable> {
    return readRpcJson(rpcClient.api.settings['event-display'].$get());
  },
};
