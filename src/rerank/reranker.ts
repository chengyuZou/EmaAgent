// 创建点冻结连接与模型身份的 Rerank 调用入口，并统一校验下标、分数和结果数量。
import { RerankError } from './errors.js';
import { createCohereRerankProtocol } from './protocols/cohere.js';
import type {
  CallRerank,
  RerankConnection,
  RerankItem,
  RerankResult,
} from './types.js';

/** Rerank 唯一创建入口；连接与 modelId 在创建时冻结，请求只执行一次，不在包内重试。 */
export function createRerankCall(connection: RerankConnection, modelId: string): CallRerank {
  if (!modelId.trim()) throw new RerankError('rerank/invalid_request', 'Rerank model must not be empty');
  const protocolRerank = createProtocolRerank(connection, modelId);
  return async (request) => {
    validateRequest(request.query);
    if (request.documents.length === 0) return { results: [] };
    const topK = resolveTopK(request.topK, request.documents.length);
    const result = await protocolRerank({ ...request, topK });
    validateResponse(result, request.documents.length, topK);
    return {
      results: [...result.results]
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, topK),
      ...(result.usage ? { usage: result.usage } : {}),
    };
  };
}

function createProtocolRerank(
  connection: RerankConnection,
  modelId: string,
): (request: Parameters<CallRerank>[0] & { readonly topK: number }) => Promise<RerankResult> {
  switch (connection.protocol) {
    case 'cohere-rerank': return createCohereRerankProtocol(connection, modelId);
  }
}

function validateRequest(query: string): void {
  if (!query.trim()) {
    throw new RerankError('rerank/invalid_request', 'Rerank query must not be empty');
  }
}

function resolveTopK(topK: number | undefined, documentCount: number): number {
  if (topK === undefined) return Math.min(5, documentCount);
  if (!Number.isSafeInteger(topK) || topK <= 0) {
    throw new RerankError('rerank/invalid_request', `Rerank topK must be positive, got ${topK}`);
  }
  return Math.min(topK, documentCount);
}

function validateResponse(result: RerankResult, documentCount: number, topK: number): void {
  if (result.results.length > topK) {
    throw new RerankError(
      'rerank/invalid_response',
      `Rerank provider returned ${result.results.length} results, limit is ${topK}`,
    );
  }
  const seen = new Set<number>();
  for (const item of result.results) {
    if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= documentCount) {
      throw new RerankError(
        'rerank/invalid_response',
        `Rerank provider returned invalid document index ${item.index}`,
      );
    }
    if (seen.has(item.index)) {
      throw new RerankError(
        'rerank/invalid_response',
        `Rerank provider returned duplicate document index ${item.index}`,
      );
    }
    if (!Number.isFinite(item.score)) {
      throw new RerankError(
        'rerank/invalid_response',
        `Rerank provider returned invalid score ${item.score}`,
      );
    }
    seen.add(item.index);
  }
}
