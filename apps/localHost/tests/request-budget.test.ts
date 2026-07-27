import { Hono, type Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  REQUEST_BUDGETS,
  requestBudgetMiddleware,
  resolveRequestBudget,
} from '../src/http/request-budget.js';

describe('LocalHost HTTP 请求预算', () => {
  it('按入口选择命名策略，读取类请求不套用 body 预算', () => {
    expect(resolveRequestBudget('POST', '/api/turns')).toBe(REQUEST_BUDGETS.turn);
    expect(resolveRequestBudget('POST', '/api/transcribe')).toBe(REQUEST_BUDGETS.audioUpload);
    expect(resolveRequestBudget('POST', '/api/cards/ema/voice-refs')).toBe(REQUEST_BUDGETS.audioUpload);
    expect(resolveRequestBudget('POST', '/api/storage/sessions/import')).toBe(REQUEST_BUDGETS.sessionImport);
    expect(resolveRequestBudget('PATCH', '/api/providers/id')).toBe(REQUEST_BUDGETS.defaultJson);
    expect(resolveRequestBudget('GET', '/api/turns/id/events')).toBeNull();
  });

  it('在 handler 解析 body 前返回结构化 413', async () => {
    const handler = vi.fn(async (context: Context) => {
      await context.req.text();
      return context.json({ ok: true });
    });
    const app = new Hono();
    app.use('*', requestBudgetMiddleware());
    app.post('/api/settings', handler);

    const response = await app.request('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(REQUEST_BUDGETS.defaultJson.maxTransportBytes + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'payload_too_large',
      message: `请求体超过 ${REQUEST_BUDGETS.defaultJson.maxTransportBytes} 字节限制`,
      budget: 'default-json',
      maxBytes: REQUEST_BUDGETS.defaultJson.maxTransportBytes,
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
