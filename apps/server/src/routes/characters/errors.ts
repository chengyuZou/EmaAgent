// 角色域错误统一映射：各业务路由共享，不在每个端点里重排 if/else。
import type { Context } from 'hono';
import {
  CharacterActiveDeleteError,
  CharacterDirectoryConflictError,
  CharacterInputInvalidError,
  CharacterNotFoundError,
  CharacterPromptInvalidError,
  CharacterReadOnlyError,
  CharacterResourceMissingError,
  CharacterResourceNotFoundError,
  CharacterResourcePathError,
  CharacterResourceValidationError,
  CharacterStateInvalidError,
} from '@ema-agent/characters';

/** 识别为角色域错误时返回映射响应；未识别的错误原样上抛，由全局错误处理落 500。 */
export function characterError(context: Context, error: unknown) {
  if (error instanceof CharacterNotFoundError || error instanceof CharacterResourceNotFoundError) {
    return context.json({ error: 'not_found', message: error.message }, 404);
  }
  if (error instanceof CharacterReadOnlyError) {
    return context.json({ error: 'read_only', message: error.message }, 403);
  }
  if (error instanceof CharacterActiveDeleteError) {
    return context.json({ error: 'active_character', message: error.message }, 409);
  }
  if (error instanceof CharacterDirectoryConflictError) {
    return context.json({ error: 'directory_conflict', message: error.message }, 409);
  }
  if (
    error instanceof CharacterInputInvalidError
    || error instanceof CharacterPromptInvalidError
    || error instanceof CharacterResourcePathError
    || error instanceof CharacterResourceValidationError
    || error instanceof CharacterStateInvalidError
    || error instanceof CharacterResourceMissingError
  ) {
    return context.json({ error: 'invalid_character', message: error.message }, 400);
  }
  throw error;
}
