import type {
  NarrativeChunkRow,
  NarrativeEntityRow,
  NarrativeRelationRow,
  NarrativeTimelineId,
} from '@ema-agent/storage';

export interface NarrativeKeywords {
  readonly highLevelKeywords: string[];
  readonly lowLevelKeywords: string[];
}

export type NarrativeQueryMode = 'local' | 'global' | 'hybrid' | 'naive' | 'mix';

export interface NarrativeTimelineFailure {
  readonly message: string;
}

export interface NarrativeRecallResult {
  readonly entities: readonly NarrativeEntityRow[];
  readonly relations: readonly NarrativeRelationRow[];
  // 只记录有正文或发生独立失败的周目. 共用步骤失败时 search 抛错.
  readonly chunksByTimeline: ReadonlyMap<
    NarrativeTimelineId,
    readonly NarrativeChunkRow[] | NarrativeTimelineFailure
  >;
}

export interface NarrativeGraphResult {
  // 数组先后就是召回优先级, 来源块分组沿用此顺序.
  readonly entities: NarrativeEntityRow[];
  readonly relations: NarrativeRelationRow[];
}
