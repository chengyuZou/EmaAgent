// 定义一次原子 Narrative Recall 的开始、完成和整体失败事件。
import type { NarrativeClientErrorCode } from './errors.js';
import type { NarrativeTimelineFailure } from './types.js';

export type NarrativeRecallFailureCode =
  | NarrativeClientErrorCode
  | 'narrative/unknown';

export interface NarrativeTimelineSummary {
  readonly name: string;
  readonly charCount: number;
  readonly snippet: string;
}

export type NarrativeEvent =
  | {
      type: 'narrative_recall_started';
      sessionId: string;
      turnId: string;
    }
  | {
      type: 'narrative_recall_completed';
      sessionId: string;
      turnId: string;
      generationId: string;
      timelineOrder: readonly string[];
      timelines: readonly NarrativeTimelineSummary[];
      failures: readonly NarrativeTimelineFailure[];
    }
  | {
      type: 'narrative_recall_failed';
      sessionId: string;
      turnId: string;
      code: NarrativeRecallFailureCode;
      message: string;
      retryable: boolean;
    };
