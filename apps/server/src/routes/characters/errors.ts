// 角色域与角色切换编排错误在 HTTP 边界统一映射。
import type { Context } from 'hono';
import {
  CharacterDirectoryConflictError,
  CharacterInputInvalidError,
  CharacterNotFoundError,
  CharacterPromptInvalidError,
  CharacterResourceNotFoundError,
  CharacterResourcePathError,
  CharacterResourceValidationError,
  CharacterStateInvalidError,
} from '@ema-agent/characters';
import { CharacterLastDeleteError, CharacterWorkRunningError } from '../../application/changeCharacter.js';

export function characterError(context: Context, error: unknown) {
  if (error instanceof CharacterNotFoundError || error instanceof CharacterResourceNotFoundError) {
    return context.json({ error: 'not_found', message: error.message }, 404);
  }
  if (error instanceof CharacterWorkRunningError || error instanceof CharacterLastDeleteError) {
    return context.json({ error: error.code, message: error.message }, 409);
  }
  if (error instanceof CharacterDirectoryConflictError) {
    return context.json({ error: 'character_name_conflict', message: error.message }, 409);
  }
  if (
    error instanceof CharacterInputInvalidError
    || error instanceof CharacterPromptInvalidError
    || error instanceof CharacterResourcePathError
    || error instanceof CharacterResourceValidationError
    || error instanceof CharacterStateInvalidError
  ) {
    return context.json({ error: 'invalid_character', message: error.message }, 400);
  }
  throw error;
}
