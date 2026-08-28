// 判断知识库文档是否落后于当前嵌入绑定:后端维护的 embeddingStale 优先,
// 再按绑定身份(providerId + modelId + dim)逐项比对。
import type { DocumentAsset } from '../../api/knowledge.js';
import type { AvailableModel, BindingRecord } from '../../api/providers.js';

/** 当前 kb-embed 绑定的解析结果;dim 从可用模型清单补全(未启用时缺失)。 */
export interface ResolvedEmbedSelection {
  providerId: string;
  modelId: string;
  dim?: number;
}

export function sameEmbedSelection(
  left?: ResolvedEmbedSelection | null,
  right?: ResolvedEmbedSelection | null,
): boolean {
  if (!left || !right) return left == null && right == null;
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

export function resolveEmbedSelection(
  models: readonly AvailableModel[],
  binding?: Pick<BindingRecord, 'providerId' | 'modelId'> | null,
): ResolvedEmbedSelection | undefined {
  if (!binding) return undefined;
  const model = models.find((candidate) =>
    candidate.providerId === binding.providerId
    && candidate.capability === 'embed'
    && candidate.modelId === binding.modelId);
  return {
    providerId: binding.providerId,
    modelId: binding.modelId,
    ...(model && model.capability === 'embed' ? { dim: model.dim } : {}),
  };
}

export function documentNeedsReembed(
  document: DocumentAsset,
  current?: ResolvedEmbedSelection,
): boolean {
  if (!current) return false;
  if (document.embeddingStale) return true;
  if (!document.embeddingModel) return true;
  return document.embeddingProviderId !== current.providerId
    || document.embeddingModel !== current.modelId
    || (current.dim !== undefined && document.embeddingDim !== current.dim);
}
