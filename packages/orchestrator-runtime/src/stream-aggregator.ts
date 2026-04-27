import type { ArtifactSummary, EmaStreamEvent, StepView, UsageView } from "@ema-agent/core-types";

/**
 * 带序号的流事件。
 *
 * API Gateway 写 SSE 时使用 seq 作为 SSE id，前端调试器也可以用它检查事件顺序。
 */
export interface SequencedStreamEvent {
  /** 从 1 开始递增的事件序号。 */
  seq: number;
  /** 原始业务事件。 */
  event: EmaStreamEvent;
}

/** StreamAggregator 的累计快照。 */
export interface StreamAggregateSnapshot {
  /** 已处理事件数。 */
  eventCount: number;
  /** 按 blockId 拼接后的输出文本。 */
  textBlocks: Record<string, string>;
  /** 最新步骤状态。 */
  steps: StepView[];
  /** 已出现的 artifact。 */
  artifacts: ArtifactSummary[];
  /** 最后一次 usage 统计。 */
  usage?: UsageView;
  /** 是否已经收到 completed/failed 终态事件。 */
  terminal: boolean;
}

/**
 * 将运行时事件流规整成稳定、可调试的顺序事件流。
 *
 * 它不改变业务事件内容，只负责：
 * - 给事件补递增 seq；
 * - 拼接 output_text_delta；
 * - 维护 steps / artifacts / usage 快照；
 * - 标记 turn 是否到达终态。
 */
export class StreamAggregator {
  private seq = 0;
  private readonly textBlocks = new Map<string, string>();
  private readonly steps = new Map<string, StepView>();
  private readonly artifacts = new Map<string, ArtifactSummary>();
  private usage: UsageView | undefined;
  private terminal = false;

  /** 接收一个事件并返回带序号事件。 */
  ingest(event: EmaStreamEvent): SequencedStreamEvent {
    this.applyToSnapshot(event);
    this.seq += 1;
    return {
      seq: this.seq,
      event,
    };
  }

  /** 返回当前累计状态，主要给测试和 developer inspector 使用。 */
  snapshot(): StreamAggregateSnapshot {
    return {
      eventCount: this.seq,
      textBlocks: Object.fromEntries(this.textBlocks),
      steps: Array.from(this.steps.values()),
      artifacts: Array.from(this.artifacts.values()),
      usage: this.usage,
      terminal: this.terminal,
    };
  }

  private applyToSnapshot(event: EmaStreamEvent): void {
    if (event.type === "output_text_delta") {
      const current = this.textBlocks.get(event.blockId) ?? "";
      this.textBlocks.set(event.blockId, `${current}${event.delta}`);
      return;
    }

    if (event.type === "step_started") {
      this.steps.set(event.step.id, event.step);
      return;
    }

    if (event.type === "step_updated") {
      const existing = this.steps.get(event.stepId);
      if (existing) {
        this.steps.set(event.stepId, { ...existing, ...event.patch });
      }
      return;
    }

    if (event.type === "artifact_upserted") {
      this.artifacts.set(event.artifact.id, event.artifact);
      return;
    }

    if (event.type === "usage_report") {
      this.usage = event.usage;
      return;
    }

    if (event.type === "turn_completed" || event.type === "turn_failed") {
      this.terminal = true;
    }
  }
}

/** 便捷包装：把普通事件流转换成带序号事件流。 */
export async function* aggregateStream(
  stream: AsyncIterable<EmaStreamEvent>,
  aggregator = new StreamAggregator(),
): AsyncIterable<SequencedStreamEvent> {
  for await (const event of stream) {
    yield aggregator.ingest(event);
  }
}
