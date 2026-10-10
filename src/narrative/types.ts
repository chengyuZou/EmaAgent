import type {
  NarrativeEntityRow,
  NarrativeRelationRow,
  NarrativeTimelineId,
} from '@ema-agent/storage';

export type NarrativeQueryMode = 'local' | 'global' | 'hybrid' | 'naive' | 'mix';

export interface NarrativeTimelineFailure {
  readonly code: 'timeline_query_failed';
  readonly message: string;
}

export type NarrativeTimelineResult = { readonly text: string } | NarrativeTimelineFailure;

/** 只包含路由选中的周目. 空 text 表示查询完成但没有背景; 取消和路由失败向调用方抛出. */
export type NarrativeRecallResult = Map<NarrativeTimelineId, NarrativeTimelineResult>;

export interface NarrativeGraphResult {
  // 数组先后就是召回优先级, 长度裁剪及来源块分组沿用此顺序.
  readonly entities: NarrativeEntityRow[];
  readonly relations: NarrativeRelationRow[];
}
