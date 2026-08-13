// 从主用 Live2D 的运行配置中提取模型真正可执行的情绪和动作名称。

import fs from 'node:fs';
import { CharacterResourceValidationError } from '../errors.js';
import { CHARACTER_RESOURCE_LIMITS } from '../resources/characterResourceLimits.js';

export interface Live2dVocabulary {
  readonly emotions: string[];
  readonly motions: string[];
}

const VOCABULARY_NAME = /^[a-z][a-z0-9_]*$/u;

/**
 * `emotionMap`/`motionMap` 是模型语义能力的事实源。
 * 空的 emotion target 不会产生舞台效果，因此不进入发给模型的词汇表。
 */
export function readLive2dVocabulary(filePath: string): Live2dVocabulary {
  const config = readRuntimeConfig(filePath);
  return {
    emotions: readEmotionNames(config.emotionMap),
    motions: readMotionNames(config.motionMap),
  };
}

function readRuntimeConfig(filePath: string): Record<string, unknown> {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > CHARACTER_RESOURCE_LIMITS.live2dManifestBytes) {
      throw new Error('runtime config is not a bounded file');
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed)) throw new Error('runtime config must be an object');
    return parsed;
  } catch (error) {
    if (error instanceof CharacterResourceValidationError) throw error;
    throw new CharacterResourceValidationError('live2d_runtime_config_invalid');
  }
}

function readEmotionNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) invalidRuntimeConfig();

  const names: string[] = [];
  for (const [name, target] of Object.entries(value)) {
    assertVocabularyName(name);
    if (!isRecord(target)) invalidRuntimeConfig();

    const hasExpression = target.expression !== undefined;
    if (hasExpression && !nonEmptyString(target.expression)) invalidRuntimeConfig();
    const hasMotion = target.motion !== undefined;
    if (hasMotion && !validMotionTarget(target.motion)) invalidRuntimeConfig();
    if (hasExpression || hasMotion) names.push(name);
  }
  return names;
}

function readMotionNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) invalidRuntimeConfig();

  const names: string[] = [];
  for (const [name, target] of Object.entries(value)) {
    assertVocabularyName(name);
    if (!validMotionTarget(target)) invalidRuntimeConfig();
    names.push(name);
  }
  return names;
}

function assertVocabularyName(value: string): void {
  if (!VOCABULARY_NAME.test(value)) invalidRuntimeConfig();
}

function validMotionTarget(value: unknown): boolean {
  if (!isRecord(value) || !nonEmptyString(value.group)) return false;
  return value.index === undefined
    || (typeof value.index === 'number' && Number.isInteger(value.index) && value.index >= 0);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidRuntimeConfig(): never {
  throw new CharacterResourceValidationError('live2d_runtime_config_invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
