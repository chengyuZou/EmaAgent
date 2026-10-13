import type { AppEvent } from '@ema-agent/server/application/appEvents.js';

const listeners = new Set<(event: AppEvent) => void>();

export function subscribeSystemEvent(listener: (event: AppEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function dispatchSystemEvent(event: AppEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[system-events] 业务监听失败:', error);
    }
  }
}
