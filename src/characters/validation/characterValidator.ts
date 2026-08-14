// 汇总角色 Prompt 与三类资源的真实可用性，输出主窗口降级顺序。

import fs from 'node:fs';
import type {
  CharacterIllustrationId,
  CharacterLive2dId,
  CharacterVoiceReferenceId,
} from '@ema-agent/ids';
import type { CharacterCard } from '../types.js';
import { findLive2dPackageFilesSync } from '../live2d/live2dValidator.js';
import { CharacterResourcePaths } from '../resources/characterResourcePaths.js';
import { CHARACTER_RESOURCE_LIMITS } from '../resources/characterResourceLimits.js';

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
  | 'voice_reference_unavailable';

export interface CharacterHealthIssue {
  readonly code: CharacterHealthIssueCode;
  readonly severity: CharacterHealthIssueSeverity;
  readonly resourceId?: string;
  readonly message: string;
}

export type CharacterPresentationCandidate =
  | { readonly kind: 'live2d'; readonly resourceId: CharacterLive2dId }
  | { readonly kind: 'illustration'; readonly resourceId: CharacterIllustrationId };

export interface CharacterHealth {
  readonly characterId: CharacterCard['id'];
  readonly status: CharacterHealthStatus;
  readonly executionAvailable: boolean;
  readonly presentation: CharacterPresentation;
  readonly selectedLive2dVariantId: CharacterLive2dId | null;
  readonly selectedIllustrationId: CharacterIllustrationId | null;
  readonly selectedVoiceReferenceId: CharacterVoiceReferenceId | null;
  readonly voiceReferenceAvailable: boolean;
  readonly presentationCandidates: readonly CharacterPresentationCandidate[];
  readonly issues: readonly CharacterHealthIssue[];
}

export class CharacterValidator {
  constructor(private readonly paths: CharacterResourcePaths) {}

  async inspect(card: CharacterCard): Promise<CharacterHealth> {
    const issues: CharacterHealthIssue[] = [];
    if (card.systemPrompt.trim().length === 0) {
      issues.push({
        code: 'prompt_empty',
        severity: 'error',
        message: '角色 Prompt 为空，不能激活或启动新 Turn。',
      });
    }

    const live2dCandidates = orderedEnabled(card.live2dVariants).filter(resource => {
      const directory = this.paths.live2dDirectory(card.id, resource.id);
      if (!isDirectory(directory)) {
        pushMissing(issues, resource.id, directory);
        return false;
      }
      try {
        findLive2dPackageFilesSync(directory);
        return true;
      } catch {
        issues.push({
          code: 'live2d_invalid',
          severity: 'warning',
          resourceId: resource.id,
          message: 'Live2D 目录缺少唯一的模型入口或 runtime-config.json。',
        });
        return false;
      }
    });

    const illustrationCandidates = orderedEnabled(card.illustrations).filter(resource => {
      let file: string;
      try {
        file = this.paths.illustrationFile(card.id, resource.id);
      } catch {
        pushMissing(issues, resource.id, String(resource.id));
        return false;
      }
      if (fs.statSync(file).size > CHARACTER_RESOURCE_LIMITS.illustrationBytes) {
        issues.push({
          code: 'illustration_too_large',
          severity: 'warning',
          resourceId: resource.id,
          message: `角色立绘超过 ${CHARACTER_RESOURCE_LIMITS.illustrationBytes} 字节限制。`,
        });
        return false;
      }
      return true;
    });

    const voiceCandidates = orderedEnabled(card.voiceReferences);
    const voice = voiceCandidates.find(resource => {
      try {
        return fs.statSync(this.paths.voiceFile(card.id, resource.id)).isFile();
      } catch {
        return false;
      }
    });

    if (live2dCandidates.length === 0) {
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
    if (voiceCandidates.length > 0 && !voice) {
      issues.push({
        code: 'voice_reference_unavailable',
        severity: 'warning',
        message: '当前参考音频不可用，声音克隆能力将被禁用。',
      });
    }

    const executionAvailable = !issues.some(issue => issue.severity === 'error');
    const presentationCandidates: CharacterPresentationCandidate[] = [
      ...live2dCandidates.map(resource => ({ kind: 'live2d' as const, resourceId: resource.id })),
      ...illustrationCandidates.map(resource => ({
        kind: 'illustration' as const,
        resourceId: resource.id,
      })),
    ];
    return {
      characterId: card.id,
      status: !executionAvailable ? 'invalid' : issues.length > 0 ? 'degraded' : 'healthy',
      executionAvailable,
      presentation: live2dCandidates.length > 0
        ? 'live2d'
        : illustrationCandidates.length > 0 ? 'illustration' : 'placeholder',
      selectedLive2dVariantId: live2dCandidates[0]?.id ?? null,
      selectedIllustrationId: illustrationCandidates[0]?.id ?? null,
      selectedVoiceReferenceId: voice?.id ?? null,
      voiceReferenceAvailable: voice !== undefined,
      presentationCandidates,
      issues,
    };
  }
}

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function pushMissing(
  issues: CharacterHealthIssue[],
  resourceId: string,
  file: string,
): void {
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
    .filter(value => value.enabled)
    .sort((left, right) => (
      Number(right.isPrimary) - Number(left.isPrimary)
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id)
    ));
}
