// 原子读取角色舞台视图，并让已经被新选择取代的请求静默失效。
//
// 视图由两份后端事实投影组装：presentation 结果（降级链、选中资源解析路径、
// 运行配置）与 Character 资源行（舞台几何与名称）。runtime-config.json 的位置
// 与解析归后端 Character 拥有，前端不自行定位或再次解析。

import { charactersApi, type CharacterPresentation } from '../api/characters.js';

/** Live2D 候选携带的运行配置（runtime-config.json 的后端解析投影）。 */
export type StageLive2dRuntimeConfig = NonNullable<CharacterPresentation['live2dRuntimeConfig']>;

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
      runtimeConfig: StageLive2dRuntimeConfig | null;
    })
  | (CharacterStageResourceBase & { kind: 'illustration' });

export interface CharacterStageView {
  characterId: string;
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
      runtimeConfig: presentation.live2dRuntimeConfig,
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

  return { characterId, candidates };
}

function findResource<T extends { id: string }>(
  resources: readonly T[],
  selectedId: string | null,
): T | undefined {
  // presentation 与 Character 是两次独立读取，期间资源可能被删除；缺失即降级到下一候选。
  return selectedId === null ? undefined : resources.find((r) => r.id === selectedId);
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
