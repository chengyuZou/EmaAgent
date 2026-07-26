// 定义 Narrative 路由和多时间线检索产生的业务事件。
import type { SessionId, TurnId } from '@ema-agent/ids';

export type NarrativeTimelineFailureCode =
  | 'narrative/unavailable'
  | 'narrative/timeout'
  | 'narrative/http_error'
  | 'narrative/invalid_response'
  | 'narrative/unknown';

export type NarrativeEvent =
  | { type: 'narrative_route_resolved'; sessionId: SessionId; turnId: TurnId; timelines: string[] }
  | { type: 'narrative_timeline_complete'; sessionId: SessionId; turnId: TurnId; timeline: string; charCount: number; snippet: string }
  | { type: 'narrative_timeline_failed'; sessionId: SessionId; turnId: TurnId; timeline: string; code: NarrativeTimelineFailureCode; message: string; retryable: boolean }
  | { type: 'narrative_recall_unavailable'; sessionId: SessionId; turnId: TurnId; code: NarrativeTimelineFailureCode; message: string; retryable: boolean };
