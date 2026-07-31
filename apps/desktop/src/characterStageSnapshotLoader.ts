// 原子读取角色舞台候选快照，并让已经被新选择取代的请求静默失效。

import type { CharacterCardId } from '@ema-agent/ids';
import type { CharacterStageSnapshot } from '@ema-agent/desktop-ui';

export interface CharacterStageSnapshotSource {
  getPresentation(cardId: CharacterCardId): Promise<CharacterStageSnapshot>;
}

export class CharacterStageSnapshotLoader {
  private generation = 0;

  constructor(private readonly source: CharacterStageSnapshotSource) {}

  invalidate(): void {
    this.generation += 1;
  }

  async load(cardId: CharacterCardId): Promise<CharacterStageSnapshot | null> {
    const generation = ++this.generation;
    try {
      const snapshot = await this.source.getPresentation(cardId);
      return generation === this.generation ? snapshot : null;
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    }
  }
}
