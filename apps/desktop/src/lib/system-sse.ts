// 管理全应用唯一的系统 SSE 连接，并把事件按顺序广播给各个窗口。

import { serverClient } from '../api/client.js';
import type { AppEvent } from '@ema-agent/server/sse/eventHub.js';
import { dispatchSystemEvent } from './system-event-dispatcher.js';
import {
  getSseOutcomeError,
  sseConsumer,
  type SseConnectionOutcome,
  type SseHandle,
} from './sse-consumer.js';
import { tauriBridge } from './tauri-bridge.js';
import { showToast } from './toast.js';
import { presentConfiguredEvent } from './event-notifications.js';

const SYSTEM_EVENT_CHANNEL = 'ema://system-event';
const EOF_RECONNECT_DELAY_MS = 3_000;
const ERROR_RECONNECT_DELAY_MS = 5_000;

export interface SystemSseControllerOptions {
  connect(onEvent: (event: AppEvent) => void): SseHandle;
  publish(event: AppEvent): void;
  onDisconnected(outcome: SseConnectionOutcome): void;
}

export interface SystemSseController {
  start(): void;
  stop(): void;
}

export interface SystemEventWindowOptions {
  /** 主桌宠窗口设为 true；其他窗口只订阅主窗口广播。 */
  ownsConnection: boolean;
}

/**
 * 创建带 generation 防护的连接控制器。
 * stop 后，旧连接的完成回调和旧重连 timer 都无权启动下一代连接。
 */
export function createSystemSseController(
  options: SystemSseControllerOptions,
): SystemSseController {
  let handle: SseHandle | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let closed = true;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer === null) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const connect = (expectedGeneration: number): void => {
    if (closed || generation !== expectedGeneration || handle !== null) return;

    const nextHandle = options.connect((event) => {
      if (closed || generation !== expectedGeneration || handle !== nextHandle) return;
      options.publish(event);
    });
    handle = nextHandle;

    void nextHandle.done.then((outcome) => {
      if (closed || generation !== expectedGeneration || handle !== nextHandle) return;
      handle = null;
      if (outcome.kind === 'cancelled') return;

      options.onDisconnected(outcome);
      const delayMs = outcome.kind === 'eof'
        ? EOF_RECONNECT_DELAY_MS
        : ERROR_RECONNECT_DELAY_MS;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect(expectedGeneration);
      }, delayMs);
    });
  };

  return {
    start() {
      if (!closed) return;
      closed = false;
      generation += 1;
      connect(generation);
    },

    stop() {
      if (closed) return;
      closed = true;
      generation += 1;
      clearReconnectTimer();
      const previousHandle = handle;
      handle = null;
      previousHandle?.stop();
    },
  };
}

let publishChain: Promise<void> = Promise.resolve();

function publishAcrossWindows(event: AppEvent): void {
  // 系统事件只由唯一 owner 展示一次；各窗口仍会收到广播并更新自己的 Store。
  presentConfiguredEvent(event);
  if (!tauriBridge.isTauri()) {
    dispatchSystemEvent(event);
    return;
  }

  // 串行广播，避免 progress/completed 等相邻事件在跨窗口时发生乱序。
  publishChain = publishChain
    .then(() => tauriBridge.emit(SYSTEM_EVENT_CHANNEL, event))
    .catch((error: unknown) => {
      console.error('[system-sse] failed to broadcast system event', error);
    });
}

const controller = createSystemSseController({
  connect(onEvent) {
    return sseConsumer.start({
      openResponse: (signal) => serverClient.requestRaw('/api/system/events', {
        signal,
        headers: { Accept: 'text/event-stream' },
      }),
      onEvent,
      onHeartbeat: () => {},
    });
  },
  publish: publishAcrossWindows,
  onDisconnected(outcome) {
    const error = getSseOutcomeError(outcome);
    if (!error) return;
    console.error('[system-sse] connection ended, will retry', error.message);
    showToast(`系统连接中断，正在重试…(${error.message})`, {
      variant: 'warning',
      duration: 5_000,
    });
  },
});

let subscriberLeases = 0;
let ownerLeases = 0;
let ownerGeneration = 0;
let subscriberGeneration = 0;
let unlistenPromise: Promise<() => void> | null = null;

function acquireSubscriber(): () => void {
  subscriberLeases += 1;
  if (subscriberLeases === 1 && tauriBridge.isTauri()) {
    subscriberGeneration += 1;
    const expectedGeneration = subscriberGeneration;
    unlistenPromise = tauriBridge.listen<AppEvent>(SYSTEM_EVENT_CHANNEL, ({ payload }) => {
      if (subscriberGeneration === expectedGeneration && subscriberLeases > 0) {
        dispatchSystemEvent(payload);
      }
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberLeases = Math.max(0, subscriberLeases - 1);
    if (subscriberLeases !== 0) return;

    subscriberGeneration += 1;
    const pendingUnlisten = unlistenPromise;
    unlistenPromise = null;
    void pendingUnlisten?.then((unlisten) => unlisten());
  };
}

/** 兼容旧调用：启动当前 WebView 中的 system SSE owner。 */
export async function startSystemSse(): Promise<void> {
  controller.start();
}

/** 兼容旧调用：永久关闭当前 WebView 中的 owner 和待重连任务。 */
export function stopSystemSse(): void {
  controller.stop();
}

/**
 * 挂载一个窗口的系统事件运行时，返回同步 disposer 供 React effect 使用。
 * Tauri 中只有主窗持有连接；普通浏览器页面会自行连接，便于独立开发。
 */
export function mountSystemEvents(options: SystemEventWindowOptions): () => void {
  const releaseSubscriber = acquireSubscriber();
  const shouldOwnConnection = options.ownsConnection || !tauriBridge.isTauri();

  if (shouldOwnConnection) {
    ownerLeases += 1;
    if (ownerLeases === 1) {
      ownerGeneration += 1;
      const expectedOwnerGeneration = ownerGeneration;
      const subscriberReady = unlistenPromise;
      if (subscriberReady) {
        // 先装好本窗 listener，再打开 SSE，避免启动瞬间丢失第一批事件。
        void subscriberReady.then(() => {
          if (ownerLeases > 0 && ownerGeneration === expectedOwnerGeneration) {
            controller.start();
          }
        });
      } else {
        controller.start();
      }
    }
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    releaseSubscriber();

    if (!shouldOwnConnection) return;
    ownerLeases = Math.max(0, ownerLeases - 1);
    if (ownerLeases === 0) {
      ownerGeneration += 1;
      controller.stop();
    }
  };
}
