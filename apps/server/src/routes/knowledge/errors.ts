// Knowledge 域路由的统一错误映射：业务错误 → HTTP 响应，未识别返回 undefined 由调用方上抛。
import type { Context } from 'hono';
import {
  KnowledgeDocumentProcessingError,
  KnowledgeInvalidRequestError,
  KnowledgeNotConfiguredError,
} from '@ema-agent/knowledge';

export function knowledgeError(context: Context, error: unknown): Response | undefined {
  if (error instanceof KnowledgeNotConfiguredError) {
    return context.json({ error: 'kb_not_configured', message: error.message }, 503);
  }
  if (error instanceof KnowledgeInvalidRequestError) {
    return context.json({ error: 'invalid_request', message: error.message }, 400);
  }
  if (error instanceof KnowledgeDocumentProcessingError) {
    return context.json({ error: 'document_processing_failed', message: error.message }, 400);
  }
  return undefined;
}
