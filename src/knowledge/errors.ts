// 定义 Knowledge 自己拥有的领域错误，不重新解释下游模型或网络错误。

export type KnowledgeErrorCode =
  | 'knowledge/missing_image_reader'
  | 'knowledge/not_configured'
  | 'knowledge/invalid_request'
  | 'knowledge/embedding_space_mismatch'
  | 'knowledge/document_processing_failed'
  | 'knowledge/semantic_fallback_warning'
  | 'knowledge/embed_batch_failed'
  | 'knowledge/embed_aborted';

export class KnowledgeMissingImageReaderError extends Error {
  readonly code = 'knowledge/missing_image_reader' as const;

  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeMissingImageReaderError';
  }
}

export class KnowledgeNotConfiguredError extends Error {
  readonly code = 'knowledge/not_configured' as const;

  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeNotConfiguredError';
  }
}

export class SemanticFallbackWarning extends Error {
  readonly code = 'knowledge/semantic_fallback_warning' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SemanticFallbackWarning';
  }
}

export class KnowledgeInvalidRequestError extends Error {
  readonly code = 'knowledge/invalid_request' as const;

  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeInvalidRequestError';
  }
}

export class KnowledgeEmbeddingSpaceMismatchError extends Error {
  readonly code = 'knowledge/embedding_space_mismatch' as const;

  constructor(
    readonly expectedSpaceId: string,
    readonly actualSpaceId: string,
  ) {
    super(`Embedding space changed during one operation: ${expectedSpaceId} -> ${actualSpaceId}`);
    this.name = 'KnowledgeEmbeddingSpaceMismatchError';
  }
}

export class KnowledgeDocumentProcessingError extends Error {
  readonly code = 'knowledge/document_processing_failed' as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'KnowledgeDocumentProcessingError';
  }
}

/** 语义分块的 embed 批次重试耗尽；message 会进 failedBatches 供上层降级与展示。 */
export class KnowledgeEmbedBatchError extends Error {
  readonly code = 'knowledge/embed_batch_failed' as const;

  constructor(batchIndex: number, model: string, cause?: unknown) {
    super(
      `Embedding batch ${batchIndex} failed after retries (model ${model})`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'KnowledgeEmbedBatchError';
  }
}

/** 把 abort 信号归一成统一文案的错误，让批次管线内的 catch 有一致形态。 */
export class KnowledgeEmbedAbortedError extends Error {
  readonly code = 'knowledge/embed_aborted' as const;

  constructor(cause?: unknown) {
    super('Embedding request was aborted', cause === undefined ? undefined : { cause });
    this.name = 'KnowledgeEmbedAbortedError';
  }
}
