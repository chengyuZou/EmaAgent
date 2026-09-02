// Providers API：/api/providers——CRUD、模型池与业务绑定（bindings）、探活、能力执行。
// TTS 试听（音频字节流）与 STT 转写（multipart）都走 requestRaw 逃生口。
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

export type ProbeCapability = InferRequestType<
  RpcClient['api']['providers'][':providerId']['probe'][':capability']['$post']
>['param']['capability'];
export type ProviderProbeInput = InferRequestType<
  RpcClient['api']['providers'][':providerId']['probe'][':capability']['$post']
>['json'];

export type TranscribeResult = RpcJson<RpcClient['api']['providers']['transcribe']['$post']>;

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

  /** 名称/图标/key/能力档位。 */
  patch(providerId: string, patch: ProviderPatchInput) {
    return readRpcJson(rpcClient.api.providers[':providerId'].$patch({
      json: patch,
      param: { providerId },
    }));
  },

  remove(providerId: string): Promise<void> {
    return readRpcVoid(rpcClient.api.providers[':providerId'].$delete({ param: { providerId } }));
  },

  /** 绑定选择器的可用模型池（连接可解析 Provider 的已启用 SQL 行）。 */
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

  /** 首次使用判定：provider_models 是否已有任何模型行。 */
  hasAnyModels() {
    return readRpcJson(rpcClient.api.providers.models['has-any'].$get());
  },

  /** 刷新 models.dev 目录并同步该能力的模型到 SQL（新增默认禁用）。 */
  refreshModels(providerId: string, capability: 'llm' | 'vision') {
    return readRpcJson(rpcClient.api.providers[':providerId'].models.refresh.$post({
      param: { providerId },
      query: { capability },
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
      param: { providerId, modelId: encodeURIComponent(modelId) },
      query: { capability },
    }));
  },

  /** 启停模型池中的一行；停用被绑定模型时 Route 以 409 model_in_use 拒绝（带 conflicts）。 */
  setModelEnabled(providerId: string, modelId: string, capability: ModelCapability, enabled: boolean) {
    return readRpcJson(rpcClient.api.providers[':providerId'].models[':modelId'].$patch({
      param: { providerId, modelId: encodeURIComponent(modelId) },
      query: { capability },
      json: { enabled },
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

  // ── 探活与试听 ──────────────────────────────────────────────────────────────

  /**
   * 探活：200 连通 / 502 失败都是正常结论（UI 都要展示），不走 readRpcJson 的异常归一；
   * 其余状态码才抛 ServerApiError。缺省 modelId 时也必须显式发 {}。
   */
  async probe(providerId: string, capability: ProbeCapability, body: ProviderProbeInput = {}) {
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

  /** STT 试听：用当前角色主参考音频到该 Provider 模型转写，返回转写文本与参考文本。 */
  sttPreview(providerId: string, modelId: string) {
    return readRpcJson(rpcClient.api.providers[':providerId']['stt-preview'].$post({
      param: { providerId },
      json: { modelId },
    }));
  },

  /** 音频字节转写为文本分段；STT 未绑定时服务端如实 503。 */
  async transcribe(input: {
    audio: Blob;
    mime: string;
    language?: string;
  }): Promise<TranscribeResult> {
    const form = new FormData();
    form.append('file', new File([input.audio], 'input', { type: input.mime || 'application/octet-stream' }));
    if (input.language) form.append('language', input.language);
    const res = await serverClient.requestRaw('/api/providers/transcribe', {
      method: 'POST',
      body: form,
    });
    return res.json();
  },
};

/** 探活结果：200 的 `{ ok: true, latencyMs }` 与 502 的 `{ ok: false, error }` 判别联合。 */
export type ProbeResult = Awaited<ReturnType<typeof providersApi.probe>>;

/** 协议展示名映射（配置页/创建页共用）。 */
export const PROTOCOL_LABELS: Record<string, string> = {
  'openai-llm':           'OpenAI 兼容',
  'openai-responses-llm': 'OpenAI Responses',
  'anthropic-llm':        'Anthropic 兼容',
  'gemini-llm':           'Gemini',
  'openai-embed':         'OpenAI 兼容',
  'gemini-embed':         'Gemini',
  'cohere-rerank':        'Cohere 兼容',
  'openai-tts':           'OpenAI 兼容',
  'dashscope-tts':        'DashScope',
  'gpt-sovits-tts':       'GPT-SoVITS',
  'openai-stt':           'OpenAI 兼容',
};

/** 按 providerId + modelId 在可用目录里精确查找模型。 */
export function findAvailableModel(
  models: AvailableModel[],
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): AvailableModel | undefined {
  if (!providerId || !modelId) return undefined;
  return models.find(
    (model) => model.providerId === providerId && model.modelId === modelId,
  );
}
