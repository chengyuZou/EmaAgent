// 原子读取角色舞台视图，并让已经被新选择取代的请求静默失效。
//
// 视图就是 presentation Route 的响应本体：降级链候选的完整渲染条目由后端
// 一次装配（含运行配置与解析路径），前端不第二次请求、不复制资源字段。

import { charactersApi, type CharacterPresentation } from '../api/characters.js';

/** Live2D 候选携带的运行配置（runtime-config.json 的后端解析投影）。 */
export type StageLive2dRuntimeConfig = NonNullable<Extract<
  CharacterPresentation['candidates'][number],
  { kind: 'live2d' }
>['runtimeConfig']>;

export type CharacterStageCandidate = CharacterPresentation['candidates'][number];

export type CharacterStageView = CharacterPresentation;

// ── 视图读取 ──────────────────────────────────────────────────────────────────

export function loadCharacterStageView(characterId: string): Promise<CharacterStageView> {
  return charactersApi.getPresentation(characterId);
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
