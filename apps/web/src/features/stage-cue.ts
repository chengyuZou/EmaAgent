import type { SseEvent } from "@ema-agent/core-types"

export type StageCue = Extract<SseEvent, { type: "stage_cue" }>["cue"]

export interface StageCueState {
  current: StageCue
  updatedAt: number
}

/**
 * StageCue reducer。
 *
 * Live2D 层只读取这个稳定状态，不直接理解 turn/tool/narrative 事件细节。
 */
export function reduceStageCueEvent(state: StageCueState, event: SseEvent): StageCueState {
  if (event.type !== "stage_cue") {
    return state
  }

  if ((event.cue.priority ?? 0) < (state.current.priority ?? 0)) {
    return state
  }

  return {
    current: event.cue,
    updatedAt: event.at,
  }
}

export function createInitialStageCueState(): StageCueState {
  return {
    current: {
      source: "system",
      expression: "neutral",
      motion: "idle",
      mouth: "idle",
      priority: 0,
    },
    updatedAt: Date.now(),
  }
}
