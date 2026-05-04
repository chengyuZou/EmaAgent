import type { StepId, SseEvent } from "@ema-agent/core-types"

export interface StepTimelineItem {
  id: StepId
  title: string
  type: "context" | "thinking" | "tool" | "diff" | "artifact" | "response" | "narrative_recall"
  status: "running" | "completed" | "failed" | "skipped"
  details: string[]
  startedAt: number
  endedAt?: number
}

export interface StepTimelineState {
  items: StepTimelineItem[]
  latestToolOutput?: {
    toolName: string
    success: boolean
    resultStr: string
  }
}

/**
 * StepTimeline 事件归约器。
 *
 * SSE 是 append-only；前端每收到一个事件就调用 reduceStepTimelineEvent，
 * 不需要重新请求后端状态。
 */
export function reduceStepTimelineEvent(state: StepTimelineState, event: SseEvent): StepTimelineState {
  if (event.type === "step_start") {
    return {
      ...state,
      items: [
        ...state.items,
        {
          id: event.stepId,
          title: event.title,
          type: event.stepType,
          status: "running",
          details: [],
          startedAt: event.at,
        },
      ],
    }
  }

  if (event.type === "step_progress") {
    return {
      ...state,
      items: state.items.map((item) => item.id === event.stepId
        ? { ...item, details: [...item.details, event.detail] }
        : item),
    }
  }

  if (event.type === "step_end") {
    return {
      ...state,
      items: state.items.map((item) => item.id === event.stepId
        ? { ...item, status: event.status, endedAt: event.at }
        : item),
    }
  }

  if (event.type === "tool_result") {
    return {
      ...state,
      latestToolOutput: {
        toolName: event.toolName,
        success: event.success,
        resultStr: event.resultStr,
      },
    }
  }

  return state
}

export function createInitialStepTimelineState(): StepTimelineState {
  return {
    items: [],
  }
}
