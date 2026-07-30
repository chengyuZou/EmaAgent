// 判断知识库文档是否属于当前 Embedding 空间，并解析模型目录中的完整身份。
import type { DocumentAssetWire } from '../../api/knowledge-base.js';
import type {
  AvailableBindingModel,
  EmbeddingSpaceWire,
} from '../../api/model-bindings.js';
import type { KbModelRef } from '../../api/settings.js';

export interface ResolvedEmbedSelection {
  providerConfigId: string;
  model: string;
  dim?: number;
  embeddingSpace?: EmbeddingSpaceWire | null;
}

export function sameKbModelRef(
  left?: KbModelRef | null,
  right?: KbModelRef | null,
): boolean {
  if (!left || !right) return left == null && right == null;
  return left.providerConfigId === right.providerConfigId
    && left.model === right.model;
}

export function resolveEmbedSelection(
  models: AvailableBindingModel[],
  ref?: KbModelRef | null,
): ResolvedEmbedSelection | undefined {
  if (!ref) return undefined;
  const model = models.find((candidate) =>
    candidate.providerConfigId === ref.providerConfigId
    && candidate.model === ref.model);
  return model ? {
    providerConfigId: model.providerConfigId,
    model: model.model,
    dim: model.dim,
    embeddingSpace: model.embeddingSpace,
  } : {
    providerConfigId: ref.providerConfigId,
    model: ref.model,
  };
}

export function documentNeedsReembed(
  document: DocumentAssetWire,
  current?: ResolvedEmbedSelection,
): boolean {
  if (!current) return false;
  if (document.ebdStale) return true;
  if (!document.ebdModel) return true;

  const space = current.embeddingSpace;
  if (space) {
    if (document.ebdSpaceId) return document.ebdSpaceId !== space.id;
    return document.ebdProviderId !== space.providerId
      || document.ebdModel !== space.model
      || document.ebdDim !== space.dim
      || document.ebdNormalization !== space.normalization
      || document.ebdRevision !== space.revision;
  }

  return document.ebdProviderId !== current.providerConfigId
    || document.ebdModel !== current.model
    || (current.dim !== undefined && document.ebdDim !== current.dim);
}
