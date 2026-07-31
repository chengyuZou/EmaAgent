// 按角色串行执行资源变更，并保留当前操作阶段供诊断和前端查询。

import { randomUUID } from 'node:crypto';
import type { CharacterCardId } from '@ema-agent/ids';

export type CharacterResourceOperationKind =
  | 'voiceReferenceUpload'
  | 'voiceReferenceDelete'
  | 'resourceImport'
  | 'resourceExport'
  | 'resourceDelete';

export type CharacterResourceOperationStage =
  | 'queued'
  | 'validating'
  | 'staging'
  | 'publishing'
  | 'finalizing'
  | 'completed'
  | 'failed';

export interface CharacterResourceOperation {
  readonly id: string;
  readonly characterId: CharacterCardId;
  readonly kind: CharacterResourceOperationKind;
  readonly stage: CharacterResourceOperationStage;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly errorMessage?: string;
}

export interface CharacterResourceOperationContext {
  setStage(stage: Exclude<
    CharacterResourceOperationStage,
    'queued' | 'completed' | 'failed'
  >): void;
}

export class CharacterResourceOperations {
  private readonly tails = new Map<CharacterCardId, Promise<void>>();
  private readonly current = new Map<CharacterCardId, CharacterResourceOperation>();
  private readonly latest = new Map<CharacterCardId, CharacterResourceOperation>();

  async run<T>(
    characterId: CharacterCardId,
    kind: CharacterResourceOperationKind,
    operation: (context: CharacterResourceOperationContext) => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(characterId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => turn);
    this.tails.set(characterId, tail);

    const startedAt = Date.now();
    let snapshot: CharacterResourceOperation = {
      id: randomUUID(),
      characterId,
      kind,
      stage: 'queued',
      startedAt,
      updatedAt: startedAt,
    };

    await previous.catch(() => undefined);
    this.current.set(characterId, snapshot);

    const setStage = (
      stage: Exclude<CharacterResourceOperationStage, 'queued' | 'completed' | 'failed'>,
    ): void => {
      snapshot = { ...snapshot, stage, updatedAt: Date.now() };
      this.current.set(characterId, snapshot);
    };

    try {
      const result = await operation({ setStage });
      snapshot = { ...snapshot, stage: 'completed', updatedAt: Date.now() };
      this.latest.set(characterId, snapshot);
      return result;
    } catch (error) {
      snapshot = {
        ...snapshot,
        stage: 'failed',
        updatedAt: Date.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      this.latest.set(characterId, snapshot);
      throw error;
    } finally {
      this.current.delete(characterId);
      release();
      if (this.tails.get(characterId) === tail) {
        this.tails.delete(characterId);
      }
    }
  }

  inspect(characterId: CharacterCardId): CharacterResourceOperation | undefined {
    return this.current.get(characterId) ?? this.latest.get(characterId);
  }

  forget(characterId: CharacterCardId): void {
    if (this.current.has(characterId) || this.tails.has(characterId)) {
      throw new Error(`character resource operation is still running: ${characterId}`);
    }
    this.latest.delete(characterId);
  }
}
