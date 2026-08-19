// 从可选 runtime-config.json 提取当前 Live2D 真正提供的情绪和动作名称。

import fs from 'node:fs';
import { CharacterResourceValidationError } from '../errors.js';

export interface Live2dVocabulary {
  readonly emotions: string[];
  readonly motions: string[];
}

const VOCABULARY_NAME = /^[a-z][a-z0-9_]*$/u;

export function readLive2dVocabulary(
  filePath: string | null,
  maxBytes: number,
): Live2dVocabulary {
  if (filePath === null) return { emotions: [], motions: [] };
  const config = readRuntimeConfig(filePath, maxBytes);
  return {
    emotions: readEmotionNames(config.emotionMap),
    motions: readMotionNames(config.motionMap),
  };
}

function readRuntimeConfig(filePath: string, maxBytes: number): Record<string, unknown> {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('runtime config is too large');
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed)) throw new Error('runtime config must be an object');
    return parsed;
  } catch {
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
