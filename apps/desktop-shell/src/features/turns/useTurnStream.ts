import { useCallback, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { EmaStreamEvent, StartTurnRequest, StartTurnResponse } from "@ema-agent/core-types";
import {
  TurnStreamAggregator,
  createEmptyTurnStreamSnapshot,
  type TurnStreamSnapshot,
} from "./stream-aggregator.js";

const API_BASE_URL = "http://127.0.0.1:3000";

/** useTurnStream 的启动参数。 */
export interface StartTurnOptions {
  /** 事件到达时的旁路回调，ChatPage 用它同步消息草稿。 */
  onEvent?: (event: EmaStreamEvent) => void;
}

/** 前端统一 turn 流 hook。 */
export interface UseTurnStreamResult {
  snapshot: TurnStreamSnapshot;
  isStreaming: boolean;
  startTurn(request: StartTurnRequest, options?: StartTurnOptions): Promise<StartTurnResponse>;
  stop(): void;
  reset(): void;
}

/**
 * 统一 turn 流消费 hook。
 *
 * 流程：
 * 1. POST /api/turns 创建 turn；
 * 2. 使用返回的 streamUrl 建 EventSource；
 * 3. 每条 SSE data 反序列化为 EmaStreamEvent；
 * 4. 交给 TurnStreamAggregator 聚合成 UI 状态。
 */
export function useTurnStream(): UseTurnStreamResult {
  const aggregatorRef = useRef(new TurnStreamAggregator());
  const eventSourceRef = useRef<EventSource | null>(null);
  const [snapshot, setSnapshot] = useState<TurnStreamSnapshot>(() => createEmptyTurnStreamSnapshot());

  const isStreaming = snapshot.running;

  const reset = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setSnapshot(aggregatorRef.current.reset());
  }, []);

  const stop = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setSnapshot((current) => ({ ...current, running: false }));
  }, []);

  const startTurn = useCallback(
    async (request: StartTurnRequest, options: StartTurnOptions = {}): Promise<StartTurnResponse> => {
      stop();

      const response = await fetch(`${API_BASE_URL}/api/turns`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Start turn failed: ${response.status}`);
      }

      const start = (await response.json()) as StartTurnResponse;
      setSnapshot(aggregatorRef.current.reset(start.requestId));

      await consumeEventSource(start, options.onEvent, aggregatorRef.current, setSnapshot, eventSourceRef);
      return start;
    },
    [stop],
  );

  return useMemo(
    () => ({
      snapshot,
      isStreaming,
      startTurn,
      stop,
      reset,
    }),
    [snapshot, isStreaming, startTurn, stop, reset],
  );
}

function consumeEventSource(
  start: StartTurnResponse,
  onEvent: ((event: EmaStreamEvent) => void) | undefined,
  aggregator: TurnStreamAggregator,
  setSnapshot: (snapshot: TurnStreamSnapshot) => void,
  eventSourceRef: MutableRefObject<EventSource | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(start.streamUrl, API_BASE_URL);
    const source = new EventSource(url.toString());
    let settled = false;
    eventSourceRef.current = source;

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as EmaStreamEvent;
      onEvent?.(event);
      const next = aggregator.ingest(event);
      setSnapshot(next);

      if (event.type === "turn_completed" || event.type === "turn_failed") {
        settled = true;
        source.close();
        eventSourceRef.current = null;
        resolve();
      }
    };

    source.onerror = () => {
      if (settled) {
        return;
      }
      settled = true;
      source.close();
      eventSourceRef.current = null;
      reject(new Error("Turn SSE connection failed."));
    };
  });
}
