// 读取可选 runtime-config.json：词汇（语义名清单）与完整映射（渲染投影）同源。

import fs from 'node:fs';
import { CharacterResourceValidationError } from '../errors.js';
import type {
  Live2dExpression,
  Live2dMotion,
  Live2dRuntimeConfig,
} from './types.js';

export interface Live2dVocabulary {
  readonly emotions: string[];
  readonly motions: string[];
}

const VOCABULARY_NAME = /^[a-z][a-z0-9_]*$/u;
export function readLive2dVocabulary(
  filePath: string | null,
): Live2dVocabulary {
  if (filePath === null) return { emotions: [], motions: [] };
  const config = readLive2dRuntimeConfig(filePath);
  return {
    emotions: Object.keys(config.emotionMap ?? {}),
    motions: Object.keys(config.motionMap ?? {}),
  };
}

/**
 * runtime-config.json 的完整校验投影。情绪只映射 Expression、动作只映射 Motion，
 * 两个映射的键不允许重名；空对象条目是作者明确置空，不进映射。
 */
export function readLive2dRuntimeConfig(
  filePath: string,
): Live2dRuntimeConfig {
  const config = readRuntimeConfig(filePath);
  const emotionMap = config.emotionMap !== undefined
    ? readEmotionMap(config.emotionMap)
    : undefined;
  const motionMap = config.motionMap !== undefined
    ? readMotionMap(config.motionMap)
    : undefined;
  if (emotionMap && motionMap) {
    for (const name of Object.keys(motionMap)) {
      if (name in emotionMap) invalidRuntimeConfig();
    }
  }
  return {
    ...(emotionMap ? { emotionMap } : {}),
    ...(motionMap ? { motionMap } : {}),
    ...(config.idleMotions !== undefined
      ? { idleMotions: readMotionList(config.idleMotions) }
      : {}),
    ...(config.lipSyncParameterIds !== undefined
      ? { lipSyncParameterIds: readParameterIds(config.lipSyncParameterIds) }
      : {}),
  };
}

function readRuntimeConfig(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed)) throw new Error('runtime config must be an object');
    return parsed;
  } catch {
    throw new CharacterResourceValidationError('live2d_runtime_config_invalid');
  }
}

function readEmotionMap(value: unknown): Record<string, Live2dExpression> {
  if (!isRecord(value)) invalidRuntimeConfig();
  const map: Record<string, Live2dExpression> = {};
  for (const [name, target] of Object.entries(value)) {
    assertVocabularyName(name);
    if (!isRecord(target)) invalidRuntimeConfig();
    // 空对象是作者明确置空：不进映射。有内容却没有 expression 键属于非法。
    if (target.expression === undefined) {
      if (Object.keys(target).length === 0) continue;
      invalidRuntimeConfig();
    }
    if (!nonEmptyString(target.expression)) invalidRuntimeConfig();
    map[name] = { expression: target.expression.trim() };
  }
  return map;
}

function readMotionMap(value: unknown): Record<string, Live2dMotion> {
  if (!isRecord(value)) invalidRuntimeConfig();
  const map: Record<string, Live2dMotion> = {};
  for (const [name, target] of Object.entries(value)) {
    assertVocabularyName(name);
    if (!isRecord(target)) invalidRuntimeConfig();
    // 空对象是作者明确置空：不进映射（不播放）。
    if (Object.keys(target).length === 0) continue;
    map[name] = readMotion(target);
  }
  return map;
}

function readMotionList(value: unknown): Live2dMotion[] {
  if (!Array.isArray(value)) invalidRuntimeConfig();
  return value.map(readMotion);
}

function readMotion(value: unknown): Live2dMotion {
  if (!isRecord(value) || !nonEmptyString(value.group)) invalidRuntimeConfig();
  if (value.index !== undefined
    && (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0)) {
    invalidRuntimeConfig();
  }
  return {
    group: value.group.trim(),
    ...(value.index === undefined ? {} : { index: value.index }),
  };
}

function readParameterIds(value: unknown): string[] {
  if (!Array.isArray(value)) invalidRuntimeConfig();
  const ids: string[] = [];
  for (const item of value) {
    if (!nonEmptyString(item)) invalidRuntimeConfig();
    ids.push(item.trim());
  }
  return ids;
}

function assertVocabularyName(value: string): void {
  if (!VOCABULARY_NAME.test(value)) invalidRuntimeConfig();
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidRuntimeConfig(): never {
  throw new CharacterResourceValidationError('live2d_runtime_config_invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
