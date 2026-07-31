// 将 Prompt 与三类表现资源检查汇总为唯一 CharacterHealth 投影。

import fs from 'node:fs';
import type {
  CharacterLive2dId,
  CharacterPortraitId,
  CharacterVoiceReferenceId,
} from '@ema-agent/ids';
import { CharacterResourcePathError } from '../errors.js';
import type { CharacterCard } from '../types.js';
import { inspectPortraitFile } from '../portraits/portraitValidator.js';
import type { CharacterResourceKind } from '../resources/characterResourcePaths.js';
import { CharacterResourcePaths } from '../resources/characterResourcePaths.js';

export type CharacterHealthStatus = 'healthy' | 'degraded' | 'invalid';
export type CharacterPresentation = 'live2d' | 'portrait' | 'placeholder';
export type CharacterHealthIssueSeverity = 'error' | 'warning';

export type CharacterHealthIssueCode =
  | 'prompt_empty'
  | 'resource_path_invalid'
  | 'resource_missing'
  | 'portrait_format_unsupported'
  | 'portrait_too_large'
  | 'portrait_dimensions_invalid'
  | 'portrait_metadata_mismatch'
  | 'live2d_unavailable'
  | 'portrait_unavailable'
  | 'voice_reference_unavailable';

export interface CharacterHealthIssue {
  readonly code: CharacterHealthIssueCode;
  readonly severity: CharacterHealthIssueSeverity;
  readonly resourceId?: string;
  readonly message: string;
}

export type CharacterPresentationCandidate =
  | {
      readonly kind: 'live2d';
      readonly resourceId: CharacterLive2dId;
    }
  | {
      readonly kind: 'portrait';
      readonly resourceId: CharacterPortraitId;
    };

export interface CharacterHealth {
  readonly characterId: CharacterCard['id'];
  readonly status: CharacterHealthStatus;
  readonly executionAvailable: boolean;
  readonly presentation: CharacterPresentation;
  readonly selectedLive2dVariantId: CharacterLive2dId | null;
  readonly selectedPortraitId: CharacterPortraitId | null;
  readonly selectedVoiceReferenceId: CharacterVoiceReferenceId | null;
  readonly voiceReferenceAvailable: boolean;
  /** 已通过文件边界检查的表现资源，顺序就是主窗口的降级顺序。 */
  readonly presentationCandidates: readonly CharacterPresentationCandidate[];
  readonly issues: readonly CharacterHealthIssue[];
}

export class CharacterValidator {
  constructor(private readonly paths: CharacterResourcePaths) {}

  async inspect(card: CharacterCard, deep = false): Promise<CharacterHealth> {
    const issues: CharacterHealthIssue[] = [];
    if (card.systemPrompt.trim().length === 0) {
      issues.push({
        code: 'prompt_empty',
        severity: 'error',
        message: '角色 Prompt 为空，不能激活或启动新 Turn。',
      });
    }

    const live2dCandidates = orderedEnabled(card.live2dVariants)
      .filter((resource) => this.inspectPath(
        card,
        resource.id,
        resource.entryPath,
        'live2d',
        issues,
      ) !== null);
    const portraitCandidates: CharacterCard['portraits'][number][] = [];
    for (const resource of orderedEnabled(card.portraits)) {
      const absolutePath = this.inspectPath(
        card,
        resource.id,
        resource.relativePath,
        'portrait',
        issues,
      );
      if (!absolutePath) continue;
      const failure = await inspectPortraitFile(resource, absolutePath, deep);
      if (failure) {
        issues.push({
          severity: 'warning',
          resourceId: resource.id,
          ...failure,
        });
        continue;
      }
      portraitCandidates.push(resource);
    }

    const voiceCandidates = orderedEnabled(card.voiceReferences);
    const voice = voiceCandidates.find((resource) => this.inspectPath(
      card,
      resource.id,
      resource.relativePath,
      'voiceReference',
      issues,
    ) !== null);

    if (live2dCandidates.length === 0) {
      issues.push({
        code: 'live2d_unavailable',
        severity: 'warning',
        message: '没有可用的 Live2D 资源，将尝试使用角色立绘。',
      });
    }
    if (portraitCandidates.length === 0) {
      issues.push({
        code: 'portrait_unavailable',
        severity: 'warning',
        message: '没有可用的角色立绘，主窗口只能显示占位状态。',
      });
    }
    if (voiceCandidates.length > 0 && !voice) {
      issues.push({
        code: 'voice_reference_unavailable',
        severity: 'warning',
        message: '当前参考音频不可用，声音克隆能力将被禁用。',
      });
    }

    const executionAvailable = !issues.some((issue) => issue.severity === 'error');
    const presentationCandidates: CharacterPresentationCandidate[] = [
      ...live2dCandidates.map((resource) => ({
        kind: 'live2d' as const,
        resourceId: resource.id,
      })),
      ...portraitCandidates.map((resource) => ({
        kind: 'portrait' as const,
        resourceId: resource.id,
      })),
    ];
    return {
      characterId: card.id,
      status: !executionAvailable
        ? 'invalid'
        : issues.length > 0 ? 'degraded' : 'healthy',
      executionAvailable,
      presentation: live2dCandidates.length > 0
        ? 'live2d'
        : portraitCandidates.length > 0 ? 'portrait' : 'placeholder',
      selectedLive2dVariantId: live2dCandidates[0]?.id ?? null,
      selectedPortraitId: portraitCandidates[0]?.id ?? null,
      selectedVoiceReferenceId: voice?.id ?? null,
      voiceReferenceAvailable: voice !== undefined,
      presentationCandidates,
      issues,
    };
  }

  private inspectPath(
    card: CharacterCard,
    resourceId: string,
    relativePath: string,
    kind: CharacterResourceKind,
    issues: CharacterHealthIssue[],
  ): string | null {
    let absolutePath: string;
    try {
      absolutePath = this.paths.resolve(card.id, card.isBuiltin, relativePath, kind);
    } catch (error) {
      issues.push({
        code: 'resource_path_invalid',
        severity: 'warning',
        resourceId,
        message: error instanceof CharacterResourcePathError
          ? error.message
          : `角色资源路径无效：${relativePath}`,
      });
      return null;
    }
    try {
      if (fs.statSync(absolutePath).isFile()) return absolutePath;
    } catch {
      // 文件可能在 exists/stat 之间被删，统一投影为 missing。
    }
    {
      issues.push({
        code: 'resource_missing',
        severity: 'warning',
        resourceId,
        message: `角色资源文件不存在：${relativePath}`,
      });
      return null;
    }
  }
}

function orderedEnabled<T extends {
  id: string;
  enabled: boolean;
  isPrimary: boolean;
  position: number;
}>(
  values: readonly T[],
): T[] {
  return values
    .filter((value) => value.enabled)
    .sort((left, right) => (
      Number(right.isPrimary) - Number(left.isPrimary)
      || left.position - right.position
      || left.id.localeCompare(right.id)
    ));
}
