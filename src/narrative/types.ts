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

export interface NarrativeTimelineResult {
  readonly entities: readonly NarrativeEntityRow[];
  readonly relations: readonly NarrativeRelationRow[];
  readonly chunks: readonly NarrativeChunkRow[];
}

// 只包含路由选中的周目. 三个数组都为空表示没有查到材料, 与查询失败分开.
export type NarrativeRecallResult = Map<
  NarrativeTimelineId,
  NarrativeTimelineResult | NarrativeTimelineFailure
>;

export interface NarrativeGraphResult {
  // 数组先后就是召回优先级, 来源块分组沿用此顺序.
  readonly entities: NarrativeEntityRow[];
  readonly relations: NarrativeRelationRow[];
}
