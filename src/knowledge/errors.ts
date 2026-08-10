// 定义 Knowledge 自己拥有的四类领域错误，不重新解释下游模型或网络错误。

export type KnowledgeErrorCode =
  | 'knowledge/not_configured'
  | 'knowledge/invalid_request'
  | 'knowledge/embedding_space_mismatch'
  | 'knowledge/document_processing_failed';

export class KnowledgeNotConfiguredError extends Error {
  readonly code = 'knowledge/not_configured' as const;

  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeNotConfiguredError';
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
