// 模型绑定 API 只传递 Provider 控制面拥有的绑定类型，不暴露数据库行结构。
import { sidecarClient } from './sidecar-client.js';
import type {
  ModelBindingModule,
  ResolvedModelBinding,
} from '@ema-agent/provider';

export type BindingModule = ModelBindingModule;
export type { ResolvedModelBinding };

export interface BindingUpsertInput {
  providerConfigId: string;
  model:            string;
  embeddingDimension?: number;
}

// ── API object ────────────────────────────────────────────────────────────────

export interface AvailableBindingModel {
  providerConfigId: string;
  providerName:     string;
  model:            string;
  contextWindow:    number;
  dim?:             number;
  maxChunks?:       number;
  /** 后端 B-049 根据 Provider 运行时生成；前端不得自行拼接或猜测。 */
  embeddingSpace?:  EmbeddingSpaceWire | null;
}

export interface EmbeddingSpaceWire {
  id:            string;
  providerId:    string;
  model:         string;
  dim:           number;
  normalization: 'l2';
  revision:      string;
}

export const modelBindingsApi = {
  /** GET /api/model-bindings — all modules' bindings. */
  async list(): Promise<ResolvedModelBinding[]> {
    return sidecarClient.request<ResolvedModelBinding[]>('/api/model-bindings');
  },

  /**
   * GET /api/model-bindings/available/:capability — the enabled-model pool the
   * picker chooses from (provider-enabled models). Only 'llm' is populated today.
   */
  async listAvailable(capability: string): Promise<AvailableBindingModel[]> {
    const res = await sidecarClient.request<{ models: AvailableBindingModel[] }>(
      `/api/model-bindings/available/${capability}`,
    );
    return res.models;
  },

  /** GET /api/model-bindings/:module */
  async listByModule(module: BindingModule): Promise<ResolvedModelBinding[]> {
    return sidecarClient.request<ResolvedModelBinding[]>(`/api/model-bindings/${module}`);
  },

  /** PUT /api/model-bindings/:module — upsert one binding. Returns updated module list. */
  async upsert(
    module: BindingModule,
    input: BindingUpsertInput,
  ): Promise<ResolvedModelBinding[]> {
    return sidecarClient.request<ResolvedModelBinding[]>(`/api/model-bindings/${module}`, {
      method: 'PUT',
      json: input,
    });
  },

  /** DELETE /api/model-bindings/:module?providerConfigId=...&model=... */
  async delete(
    module: BindingModule,
    providerConfigId: string,
    model: string,
  ): Promise<void> {
    const params = new URLSearchParams({ providerConfigId, model });
    await sidecarClient.request(`/api/model-bindings/${module}?${params}`, {
      method: 'DELETE',
    });
  },

  /**
   * PUT /api/model-bindings/:module/set — atomic single-select: wipes all
   * existing bindings for the module, then sets the one given model.
   */
  async set(
    module: BindingModule,
    input: BindingUpsertInput,
  ): Promise<ResolvedModelBinding[]> {
    return sidecarClient.request<ResolvedModelBinding[]>(
      `/api/model-bindings/${module}/set`,
      { method: 'PUT', json: input },
    );
  },
};
