// 原子读取角色舞台视图（候选集 + 修订号），并让已经被新选择取代的请求静默失效。
//
// 视图由三份冻结事实投影组装：presentation（后端冻结的降级链与选中资源解析路径）、
// Character 资源行（舞台几何与名称）、Live2D 包内 runtime-config.json（情绪/动作
// 语义映射，宿主投影，缺失时整个 Live2D 候选仍可无映射渲染）。

import { charactersApi, type Character } from './api/characters.js';
import { serverClient } from './api/client.js';
import type {
  Live2DModelBindings,
  Live2DMotionReference,
} from '@ema-agent/live2d-react';

// ── 舞台 ViewModel ────────────────────────────────────────────────────────────

/**
 * 角色语义情绪/动作名到模型原生表情/动作的映射（runtime-config.json 的宿主投影）。
 * bindings 字段直接透传给 Live2DStage；缺省时口型用模型自带 LipSync group、无待机动作。
 */
export interface CharacterLive2dRuntimeConfig extends Live2DModelBindings {
  emotionMap?: Record<string, { expression?: string; motion?: Live2DMotionReference }>;
  motionMap?: Record<string, Live2DMotionReference>;
}

interface CharacterStageResourceBase {
  resourceId: string;
  name: string;
  /** 候选去重用的稳定修订号，取资源行 updatedAt。 */
  resourceRevision: string;
  /** Live2D 为 model3.json、立绘为图片文件的服务端绝对路径（渲染侧经 convertFileSrc 读取）。 */
  sourcePath: string;
  stageScale: number;
  stageOffsetX: number;
  stageOffsetY: number;
}

export type CharacterStageCandidate =
  | (CharacterStageResourceBase & {
      kind: 'live2d';
      runtimeConfig: CharacterLive2dRuntimeConfig | null;
    })
  | (CharacterStageResourceBase & { kind: 'illustration' });

export interface CharacterStageView {
  characterId: string;
  /** 视图修订号，取 Character.updatedAt；候选自身的修订由 candidateKey 表达。 */
  revision: string;
  /** 按后端降级链排序的可渲染候选；空数组 = 占位。 */
  candidates: CharacterStageCandidate[];
}

// ── 视图组装 ──────────────────────────────────────────────────────────────────

/**
 * 读取一个角色的舞台视图。presentation 只对当前选中的 Live2D/立绘解析渲染路径，
 * 因此候选集 = 选中 Live2D（可选）+ 选中立绘（可选），顺序即降级链。
 */
export async function loadCharacterStageView(characterId: string): Promise<CharacterStageView> {
  const [presentation, character] = await Promise.all([
    charactersApi.getPresentation(characterId),
    charactersApi.get(characterId),
  ]);

  const candidates: CharacterStageCandidate[] = [];

  const live2d = findResource(character.live2dModels, presentation.selectedLive2dModelId);
  if (live2d && presentation.live2dModelFile) {
    candidates.push({
      kind: 'live2d',
      resourceId: live2d.id,
      name: live2d.name,
      resourceRevision: String(live2d.updatedAt),
      sourcePath: presentation.live2dModelFile,
      stageScale: live2d.stageScale,
      stageOffsetX: live2d.stageOffsetX,
      stageOffsetY: live2d.stageOffsetY,
      runtimeConfig: await loadLive2dRuntimeConfig(characterId, live2d.id),
    });
  }

  const illustration = findResource(character.illustrations, presentation.selectedIllustrationId);
  if (illustration && presentation.illustrationFile) {
    candidates.push({
      kind: 'illustration',
      resourceId: illustration.id,
      name: illustration.name,
      resourceRevision: String(illustration.updatedAt),
      sourcePath: presentation.illustrationFile,
      stageScale: illustration.stageScale,
      stageOffsetX: illustration.stageOffsetX,
      stageOffsetY: illustration.stageOffsetY,
    });
  }

  return {
    characterId,
    revision: String(character.updatedAt),
    candidates,
  };
}

function findResource<T extends { id: string }>(
  resources: readonly T[],
  selectedId: string | null,
): T | undefined {
  // presentation 与 Character 是两次独立读取，期间资源可能被删除；缺失即降级到下一候选。
  return selectedId === null ? undefined : resources.find((r) => r.id === selectedId);
}

/** runtime-config.json 位于 Live2D 资源目录根；404 或读取失败都视为无映射配置。 */
async function loadLive2dRuntimeConfig(
  characterId: string,
  resourceId: string,
): Promise<CharacterLive2dRuntimeConfig | null> {
  try {
    const url = await charactersApi.getLive2dFileUrl(characterId, resourceId, 'runtime-config.json');
    const headers = await serverClient.getAuthHeaders();
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`runtime-config fetch failed: ${res.status}`);
    return (await res.json()) as CharacterLive2dRuntimeConfig;
  } catch (error) {
    console.warn('[stage] Live2D runtime-config 读取失败，按无映射降级', error);
    return null;
  }
}

// ── 载入守卫 ──────────────────────────────────────────────────────────────────

export interface CharacterStageViewSource {
  load(characterId: string): Promise<CharacterStageView>;
}

export class CharacterStageLoader {
  private generation = 0;

  constructor(private readonly source: CharacterStageViewSource) {}

  invalidate(): void {
    this.generation += 1;
  }

  async load(characterId: string): Promise<CharacterStageView | null> {
    const generation = ++this.generation;
    try {
      const view = await this.source.load(characterId);
      return generation === this.generation ? view : null;
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    }
  }
}
