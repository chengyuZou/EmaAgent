// 检查角色 Prompt 与三类资源的当前可用性，并给出主窗口实际降级顺序。

import fs from 'node:fs';
import path from 'node:path';
import type { Character } from './types.js';
import type { CharacterSettings } from './settings.js';
import { findLive2dPackageFilesSync } from './live2d/live2dValidator.js';
import { CharacterResourcePaths } from './resources/resourcePaths.js';
import { assertCharacterPromptBlocks } from './characterPrompt.js';

export type CharacterHealthStatus = 'healthy' | 'degraded' | 'invalid';
export type CharacterPresentation = 'live2d' | 'illustration' | 'placeholder';
export type CharacterHealthIssueSeverity = 'error' | 'warning';

export type CharacterHealthIssueCode =
  | 'prompt_empty'
  | 'resource_missing'
  | 'illustration_too_large'
  | 'live2d_invalid'
  | 'live2d_unavailable'
  | 'illustration_unavailable'
  | 'voice_sample_unavailable';

export interface CharacterHealthIssue {
  readonly code: CharacterHealthIssueCode;
  readonly severity: CharacterHealthIssueSeverity;
  readonly resourceId?: string;
  readonly message: string;
}

export type CharacterPresentationCandidate =
  | { readonly kind: 'live2d'; readonly resourceId: string }
  | { readonly kind: 'illustration'; readonly resourceId: string };

export interface CharacterHealth {
  readonly characterId: Character['id'];
  readonly status: CharacterHealthStatus;
  readonly executionAvailable: boolean;
  readonly presentation: CharacterPresentation;
  readonly selectedLive2dModelId: string | null;
  readonly selectedIllustrationId: string | null;
  readonly selectedVoiceSampleId: string | null;
  readonly voiceSampleAvailable: boolean;
  readonly presentationCandidates: readonly CharacterPresentationCandidate[];
  readonly issues: readonly CharacterHealthIssue[];
}

export interface CharacterHealthReport {
  readonly characters: readonly CharacterHealth[];
  /** 磁盘存在但 SQLite 没有引用的一层目录或文件。 */
  readonly orphanedPaths: readonly string[];
}

export async function inspectCharacterHealth(
  character: Character,
  paths: CharacterResourcePaths,
  settings: CharacterSettings,
): Promise<CharacterHealth> {
  const issues: CharacterHealthIssue[] = [];
  try {
    assertCharacterPromptBlocks(character.promptBlocks, settings.prompt, character.id);
  } catch {
    issues.push({
      code: 'prompt_empty',
      severity: 'error',
      message: '角色 Prompt 为空，不能激活或启动新 Turn。',
    });
  }

  const live2dModelCandidates = orderedEnabled(character.live2dModels).filter((resource) => {
    const directory = paths.live2dModelDirectory(
      character.directoryName,
      resource.directoryName,
    );
    try {
      findLive2dPackageFilesSync(directory);
      return true;
    } catch {
      issues.push({
        code: fs.existsSync(directory) ? 'live2d_invalid' : 'resource_missing',
        severity: 'warning',
        resourceId: resource.id,
        message: fs.existsSync(directory)
          ? 'Live2D 目录必须包含唯一的 model3.json，runtime-config.json 如存在也必须有效。'
          : `角色资源不存在：${directory}`,
      });
      return false;
    }
  });

  const illustrationCandidates = orderedEnabled(character.illustrations).filter((resource) => {
    const file = paths.illustrationFile(character.directoryName, resource.fileName);
    const stat = safeStat(file);
    if (!stat?.isFile()) {
      pushMissing(issues, resource.id, file);
      return false;
    }
    if (stat.size > settings.illustration.maxBytes) {
      issues.push({
        code: 'illustration_too_large',
        severity: 'warning',
        resourceId: resource.id,
        message: `角色立绘超过 ${settings.illustration.maxBytes} 字节限制。`,
      });
      return false;
    }
    return true;
  });

  const voiceSampleCandidates = orderedEnabled(character.voiceSamples);
  const voiceSample = voiceSampleCandidates.find((resource) => (
    safeStat(paths.voiceFile(character.directoryName, resource.fileName))?.isFile() === true
  ));

  if (live2dModelCandidates.length === 0) {
    issues.push({
      code: 'live2d_unavailable',
      severity: 'warning',
      message: '没有可用的 Live2D 资源，将尝试使用角色立绘。',
    });
  }
  if (illustrationCandidates.length === 0) {
    issues.push({
      code: 'illustration_unavailable',
      severity: 'warning',
      message: '没有可用的角色立绘，主窗口只能显示占位状态。',
    });
  }
  if (voiceSampleCandidates.length > 0 && !voiceSample) {
    issues.push({
      code: 'voice_sample_unavailable',
      severity: 'warning',
      message: '当前参考音频不可用，声音克隆能力将被禁用。',
    });
  }

  const executionAvailable = !issues.some((issue) => issue.severity === 'error');
  const presentationCandidates: CharacterPresentationCandidate[] = [
    ...live2dModelCandidates.map((resource) => ({
      kind: 'live2d' as const,
      resourceId: resource.id,
    })),
    ...illustrationCandidates.map((resource) => ({
      kind: 'illustration' as const,
      resourceId: resource.id,
    })),
  ];
  return {
    characterId: character.id,
    status: !executionAvailable ? 'invalid' : issues.length > 0 ? 'degraded' : 'healthy',
    executionAvailable,
    presentation: live2dModelCandidates.length > 0
      ? 'live2d'
      : illustrationCandidates.length > 0 ? 'illustration' : 'placeholder',
    selectedLive2dModelId: live2dModelCandidates[0]?.id ?? null,
    selectedIllustrationId: illustrationCandidates[0]?.id ?? null,
    selectedVoiceSampleId: voiceSample?.id ?? null,
    voiceSampleAvailable: voiceSample !== undefined,
    presentationCandidates,
    issues,
  };
}

/**
 * 启动时扫描一次全部角色。它只比较 SQL 声明的稳定物理名与对应目录的
 * 第一层条目，不猜测孤儿是否由用户重命名而来，也不自动修复。
 */
export async function inspectAllCharacterHealth(
  characters: readonly Character[],
  paths: CharacterResourcePaths,
  settings: CharacterSettings,
): Promise<CharacterHealthReport> {
  const health = await Promise.all(
    characters.map((character) => inspectCharacterHealth(character, paths, settings)),
  );
  return {
    characters: health,
    orphanedPaths: listOrphanedPaths(characters, paths),
  };
}

function safeStat(filePath: string): fs.Stats | null {
  try { return fs.statSync(filePath); } catch { return null; }
}

function pushMissing(issues: CharacterHealthIssue[], resourceId: string, file: string): void {
  issues.push({
    code: 'resource_missing',
    severity: 'warning',
    resourceId,
    message: `角色资源不存在：${file}`,
  });
}

function orderedEnabled<T extends {
  id: string;
  enabled: boolean;
  isPrimary: boolean;
  createdAt: number;
}>(values: readonly T[]): T[] {
  return values
    .filter((value) => value.enabled)
    .sort((left, right) => (
      Number(right.isPrimary) - Number(left.isPrimary)
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id)
    ));
}

function listOrphanedPaths(
  characters: readonly Character[],
  paths: CharacterResourcePaths,
): string[] {
  const result: string[] = [];
  const byDirectoryName = new Map(
    characters.map((character) => [character.directoryName, character]),
  );
  for (const entry of readDirectory(paths.charactersRoot())) {
    const entryPath = path.join(paths.charactersRoot(), entry.name);
    const character = byDirectoryName.get(entry.name);
    if (!character || !entry.isDirectory()) {
      result.push(entryPath);
      continue;
    }
    collectUnexpectedEntries(
      paths.live2dRoot(character.directoryName),
      new Set(character.live2dModels.map((resource) => resource.directoryName)),
      result,
    );
    collectUnexpectedEntries(
      paths.illustrationRoot(character.directoryName),
      new Set(character.illustrations.map((resource) => resource.fileName)),
      result,
    );
    collectUnexpectedEntries(
      paths.voiceRoot(character.directoryName),
      new Set(character.voiceSamples.map((resource) => resource.fileName)),
      result,
    );
  }
  return result.sort();
}

function collectUnexpectedEntries(
  directory: string,
  expectedNames: ReadonlySet<string>,
  result: string[],
): void {
  for (const entry of readDirectory(directory)) {
    if (!expectedNames.has(entry.name)) result.push(path.join(directory, entry.name));
  }
}

function readDirectory(directory: string): fs.Dirent[] {
  try { return fs.readdirSync(directory, { withFileTypes: true }); }
  catch { return []; }
}
