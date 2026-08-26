// Providers API：/api/providers——CRUD、Key 管理、模型池与业务绑定（bindings）、探活。
// TTS 试听（音频字节流）走 requestRaw；STT 转写在 transcribe.ts。
import type { InferRequestType } from 'hono/client';
import {
  rpcClient,
  readRpcJson,
  readRpcVoid,
  serverClient,
  toServerApiError,
  type RpcClient,
  type RpcJson,
} from './client.js';

// ── 类型（全部从路由契约推导） ────────────────────────────────────────────────

export type ProviderList = RpcJson<RpcClient['api']['providers']['$get']>;
export type ProviderRecord = ProviderList[number];
export type ProviderConfigInput = InferRequestType<RpcClient['api']['providers']['$post']>['json'];
export type ProviderPatchInput = InferRequestType<RpcClient['api']['providers'][':providerId']['$patch']>['json'];

/** 模型能力枚举：与路由 paramValidator/queryValidator 同源。 */
export type ModelCapability = InferRequestType<
  RpcClient['api']['providers']['available'][':capability']['$get']
>['param']['capability'];

export type AvailableModelsResult = RpcJson<RpcClient['api']['providers']['available'][':capability']['$get']>;
export type AvailableModel = AvailableModelsResult['models'][number];
export type ProviderModelsResult = RpcJson<RpcClient['api']['providers'][':providerId']['models']['$get']>;
export type ProviderModelRecord = ProviderModelsResult[number];
export type ProviderModelInput = InferRequestType<RpcClient['api']['providers'][':providerId']['models']['$put']>['json'];

export type BindingsList = RpcJson<RpcClient['api']['providers']['bindings']['$get']>;
export type BindingModule = InferRequestType<
  RpcClient['api']['providers']['bindings'][':module']['$put']
>['param']['module'];
export type BindingUpsertInput = InferRequestType<RpcClient['api']['providers']['bindings'][':module']['$put']>['json'];
export type BindingRecord = RpcJson<RpcClient['api']['providers']['bindings'][':module']['$put']>;

export type ProviderKeyList = RpcJson<RpcClient['api']['providers'][':providerId']['keys']['$get']>;
export type ProviderKeyRecord = ProviderKeyList[number];
export type ProviderKeyAddInput = InferRequestType<RpcClient['api']['providers'][':providerId']['keys']['$post']>['json'];
export type ProviderKeySelectInput = InferRequestType<RpcClient['api']['providers'][':providerId']['keys']['select']['$post']>['json'];

export type ProbeCapability = InferRequestType<
  RpcClient['api']['providers'][':providerId']['probe'][':capability']['$post']
>['param']['capability'];

// ── API ──────────────────────────────────────────────────────────────────────

export const providersApi = {
  list(): Promise<ProviderList> {
    return readRpcJson(rpcClient.api.providers.$get());
  },

  /** 创建（自建与内置种子同构）。 */
  create(body: ProviderConfigInput) {
    return readRpcJson(rpcClient.api.providers.$post({ json: body }));
  },

  get(providerId: string) {
    return readRpcJson(rpcClient.api.providers[':providerId'].$get({ param: { providerId } }));
  },

  /** 名称/图标/启停/能力档位。 */
  patch(providerId: string, patch: ProviderPatchInput) {
    return readRpcJson(rpcClient.api.providers[':providerId'].$patch({
      json: patch,
      param: { providerId },
    }));
  },

  remove(providerId: string): Promise<void> {
    return readRpcVoid(rpcClient.api.providers[':providerId'].$delete({ param: { providerId } }));
  },

  /** 绑定选择器的可用模型池（该能力下全部已启用模型 + Provider 名）。 */
  listAvailable(capability: ModelCapability): Promise<AvailableModelsResult> {
    return readRpcJson(rpcClient.api.providers.available[':capability'].$get({
      param: { capability },
    }));
  },

  listModels(providerId: string): Promise<ProviderModelsResult> {
    return readRpcJson(rpcClient.api.providers[':providerId'].models.$get({
      param: { providerId },
    }));
  },

  /** 保存/启用一条模型记录。 */
  saveModel(providerId: string, body: ProviderModelInput) {
    return readRpcJson(rpcClient.api.providers[':providerId'].models.$put({
      json: body,
      param: { providerId },
    }));
  },

  deleteModel(providerId: string, modelId: string, capability: ModelCapability): Promise<void> {
    return readRpcVoid(rpcClient.api.providers[':providerId'].models[':modelId'].$delete({
      param: { providerId, modelId },
      query: { capability },
    }));
  },

  // ── 业务绑定（一个业务位一条绑定） ──────────────────────────────────────────

  listBindings(): Promise<BindingsList> {
    return readRpcJson(rpcClient.api.providers.bindings.$get());
  },

  /** upsert 一条绑定并返回该模块绑定。 */
  setBinding(module: BindingModule, body: BindingUpsertInput): Promise<BindingRecord> {
    return readRpcJson(rpcClient.api.providers.bindings[':module'].$put({
      json: body,
      param: { module },
    }));
  },

  deleteBinding(module: BindingModule): Promise<void> {
    return readRpcVoid(rpcClient.api.providers.bindings[':module'].$delete({ param: { module } }));
  },

  // ── Keys ────────────────────────────────────────────────────────────────────

  listKeys(providerId: string, capability: ModelCapability): Promise<ProviderKeyList> {
    return readRpcJson(rpcClient.api.providers[':providerId'].keys.$get({
      param: { providerId },
      query: { capability },
    }));
  },

  /** 首次配置某能力时的预填：取全 provider 最近一把 key。 */
  prefillKey(providerId: string, capability: ModelCapability) {
    return readRpcJson(rpcClient.api.providers[':providerId'].keys.prefill.$get({
      param: { providerId },
      query: { capability },
    }));
  },

  addKey(providerId: string, body: ProviderKeyAddInput) {
    return readRpcJson(rpcClient.api.providers[':providerId'].keys.$post({
      json: body,
      param: { providerId },
    }));
  },

  selectKey(providerId: string, body: ProviderKeySelectInput): Promise<void> {
    return readRpcVoid(rpcClient.api.providers[':providerId'].keys.select.$post({
      json: body,
      param: { providerId },
    }));
  },

  deleteKey(providerId: string, keyId: string, capability: ModelCapability): Promise<void> {
    return readRpcVoid(rpcClient.api.providers[':providerId'].keys[':keyId'].$delete({
      param: { providerId, keyId },
      query: { capability },
    }));
  },

  // ── 探活与试听 ──────────────────────────────────────────────────────────────

  /**
   * 探活：200 连通 / 502 失败都是正常结论（UI 都要展示），不走 readRpcJson 的异常归一；
   * 其余状态码才抛 ServerApiError。缺省 modelId 时也必须显式发 {}。
   */
  async probe(providerId: string, capability: ProbeCapability, body: { modelId?: string } = {}) {
    const res = await rpcClient.api.providers[':providerId'].probe[':capability'].$post({
      json: body,
      param: { providerId, capability },
    });
    if (res.status === 200 || res.status === 502) return res.json();
    throw await toServerApiError(res);
  },

  /** TTS 试听：音频字节流，走 requestRaw 逃生口。 */
  ttsPreview(providerId: string, modelId: string, text?: string): Promise<Response> {
    return serverClient.requestRaw(`/api/providers/${providerId}/tts-preview`, {
      method: 'POST',
      json: { modelId, ...(text ? { text } : {}) },
    });
  },
};

/** 探活结果：200 的 `{ ok: true, latencyMs }` 与 502 的 `{ ok: false, error }` 判别联合。 */
export type ProbeResult = Awaited<ReturnType<typeof providersApi.probe>>;
