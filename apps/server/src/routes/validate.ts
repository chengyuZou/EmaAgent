// 统一 body 校验入口：400 形状保持 {error:'invalid_request', details:flattenError()}，与现状一致。
// schema 永远留在原路由文件；这里只提供"校验前置"的共享中间件工厂。
// 泛型必须流出去：S 擦成 ZodType 会让所有 req.valid() 退化为 unknown。
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
