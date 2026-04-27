import type { ArtifactSummary, EmaStreamEvent, StepView, UsageView } from "@ema-agent/core-types";

/** 前端聚合后的 turn 流状态。 */
export interface TurnStreamSnapshot {
  /** 当前 requestId。 */
  requestId?: string;
  /** 按 blockId 拼接后的文本块。 */
  textBlocks: Record<string, string>;
  /** 步骤时间线。 */
  steps: StepView[];
  /** Workspace 产物摘要。 */
  artifacts: ArtifactSummary[];
  /** usage/cost 统计。 */
  usage?: UsageView;
  /** 是否处于流式连接中。 */
  running: boolean;
  /** 最后一次错误消息。 */
  error?: string;
  /** turn 开始时间。 */
  startedAt?: number;
  /** turn 结束时间。 */
  completedAt?: number;
}

/** 创建空快照，确保 React state 初始化稳定。 */
export function createEmptyTurnStreamSnapshot(): TurnStreamSnapshot {
  return {
    textBlocks: {},
    steps: [],
    artifacts: [],
    running: false,
  };
}

/**
 * 前端流聚合器。
 *
 * 它负责把 SSE 事件转换成 UI 能直接消费的状态：
 * - output_text_delta 拼接为完整文本；
 * - step_started/step_updated 合并为步骤列表；
 * - artifact_upserted 合并为 Workspace 列表；
 * - turn_completed/turn_failed 标记终态。
 */
export class TurnStreamAggregator {
  private snapshotValue = createEmptyTurnStreamSnapshot();
  private readonly steps = new Map<string, StepView>();
  private readonly artifacts = new Map<string, ArtifactSummary>();

  /** 重置为一个新 turn。 */
  reset(requestId?: string): TurnStreamSnapshot {
    this.steps.clear();
    this.artifacts.clear();
    this.snapshotValue = {
      ...createEmptyTurnStreamSnapshot(),
      requestId,
    };
    return this.snapshot();
  }

  /** 接收一个事件并返回新的不可变快照。 */
  ingest(event: EmaStreamEvent): TurnStreamSnapshot {
    if (event.type === "turn_started") {
      this.snapshotValue = {
        ...this.snapshotValue,
        requestId: event.requestId,
        startedAt: event.at,
        running: true,
        error: undefined,
      };
      return this.snapshot();
    }

    if (event.type === "output_text_delta") {
      const current = this.snapshotValue.textBlocks[event.blockId] ?? "";
      this.snapshotValue = {
        ...this.snapshotValue,
        textBlocks: {
          ...this.snapshotValue.textBlocks,
          [event.blockId]: `${current}${event.delta}`,
        },
      };
      return this.snapshot();
    }

    if (event.type === "step_started") {
      this.steps.set(event.step.id, event.step);
      this.syncSteps();
      return this.snapshot();
    }

    if (event.type === "step_updated") {
      const existing = this.steps.get(event.stepId);
      if (existing) {
        this.steps.set(event.stepId, { ...existing, ...event.patch });
        this.syncSteps();
      }
      return this.snapshot();
    }

    if (event.type === "artifact_upserted") {
      this.artifacts.set(event.artifact.id, event.artifact);
      this.snapshotValue = {
        ...this.snapshotValue,
        artifacts: Array.from(this.artifacts.values()),
      };
      return this.snapshot();
    }

    if (event.type === "usage_report") {
      this.snapshotValue = {
        ...this.snapshotValue,
        usage: event.usage,
      };
      return this.snapshot();
    }

    if (event.type === "turn_completed") {
      this.snapshotValue = {
        ...this.snapshotValue,
        running: false,
        completedAt: event.at,
      };
      return this.snapshot();
    }

    if (event.type === "turn_failed") {
      this.snapshotValue = {
        ...this.snapshotValue,
        running: false,
        error: event.error.message,
        completedAt: Date.now(),
      };
      return this.snapshot();
    }

    return this.snapshot();
  }

  /** 返回当前快照的浅拷贝，避免外部直接修改内部状态。 */
  snapshot(): TurnStreamSnapshot {
    return {
      ...this.snapshotValue,
      textBlocks: { ...this.snapshotValue.textBlocks },
      steps: [...this.snapshotValue.steps],
      artifacts: [...this.snapshotValue.artifacts],
    };
  }

  private syncSteps(): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      steps: Array.from(this.steps.values()),
    };
  }
}
