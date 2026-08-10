// 为同进程宿主转发 Knowledge 业务事件，不承担状态持久化。

import { EventEmitter } from 'node:events';
import type { KnowledgeEvent } from '../events.js';

export class KnowledgeEvents {
  private readonly emitter = new EventEmitter();

  emit(event: KnowledgeEvent): void {
    this.emitter.emit('event', event);
  }

  on(handler: (event: KnowledgeEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }
}
