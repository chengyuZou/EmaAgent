// 定义一次原子 Narrative Recall 的开始、完成和整体失败事件。
import type { SessionId, TurnId } from '@ema-agent/ids';
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
      sessionId: SessionId;
      turnId: TurnId;
    }
  | {
      type: 'narrative_recall_completed';
      sessionId: SessionId;
      turnId: TurnId;
      generationId: string;
      timelineOrder: readonly string[];
      timelines: readonly NarrativeTimelineSummary[];
      failures: readonly NarrativeTimelineFailure[];
    }
  | {
      type: 'narrative_recall_failed';
      sessionId: SessionId;
      turnId: TurnId;
      code: NarrativeRecallFailureCode;
      message: string;
      retryable: boolean;
    };
