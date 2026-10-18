// 保留具体 Schema 泛型, Hono 的 req.valid() 和 Desktop RPC 才能推导实际请求字段.
import { zValidator } from '@hono/zod-validator';
import { z, type ZodType } from 'zod';

export const jsonBody = <S extends ZodType>(schema: S) =>
  zValidator('json', schema, (result, context) => {
    if (result.success) return;
    return context.json({ error: 'invalid_request', details: z.flattenError(result.error) }, 400);
  });

export const formBody = <S extends ZodType>(schema: S) =>
  zValidator('form', schema, (result, context) => {
    if (result.success) return;
    return context.json({ error: 'invalid_request', details: z.flattenError(result.error) }, 400);
  });

export const queryValidator = <S extends ZodType>(schema: S) =>
  zValidator('query', schema, (result, context) => {
    if (result.success) return;
    return context.json({ error: 'invalid_request', details: z.flattenError(result.error) }, 400);
  });

export const paramValidator = <S extends ZodType>(schema: S) =>
  zValidator('param', schema, (result, context) => {
    if (result.success) return;
    return context.json({ error: 'invalid_request', details: z.flattenError(result.error) }, 400);
  });
