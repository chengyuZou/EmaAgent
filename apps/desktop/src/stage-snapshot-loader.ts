// 原子加载当前角色的 Live2D 路径与运行配置，并丢弃已经过期的异步结果。
import type { CharacterCardId } from '@ema-agent/contracts';
import type { Live2DModelRuntimeConfig } from '@ema-agent/live2d-react';

export interface ActiveStageSnapshot {
  cardId: CharacterCardId;
  modelPath: string;
  runtimeConfig: Live2DModelRuntimeConfig | null;
}

export interface StageSnapshotSource {
  getModelPath(cardId: CharacterCardId): Promise<string>;
  getRuntimeConfig(cardId: CharacterCardId): Promise<Live2DModelRuntimeConfig | null>;
}

export class StageSnapshotLoader {
  private generation = 0;

  constructor(private readonly source: StageSnapshotSource) {}

  invalidate(): void {
    this.generation += 1;
  }

  async load(cardId: CharacterCardId): Promise<ActiveStageSnapshot | null> {
    const generation = ++this.generation;
    const [modelPathResult, runtimeConfigResult] = await Promise.allSettled([
      this.source.getModelPath(cardId),
      this.source.getRuntimeConfig(cardId),
    ]);

    // 用户已经切换角色或组件已卸载，迟到的成功和失败都不能再影响舞台。
    if (generation !== this.generation) return null;

    if (modelPathResult.status === 'rejected') throw modelPathResult.reason;
    if (runtimeConfigResult.status === 'rejected') throw runtimeConfigResult.reason;

    return {
      cardId,
      modelPath: modelPathResult.value,
      runtimeConfig: runtimeConfigResult.value,
    };
  }
}
