import { EventEmitter } from 'node:events';
import type { DocumentProgressEvent } from './types.js';

export class DocumentEventEmitter {
  private readonly emitter = new EventEmitter();

  emit(event: DocumentProgressEvent): void {
    this.emitter.emit('progress', event);
  }

  on(handler: (event: DocumentProgressEvent) => void): void {
    this.emitter.on('progress', handler);
  }

  off(handler: (event: DocumentProgressEvent) => void): void {
    this.emitter.off('progress', handler);
  }

  once(handler: (event: DocumentProgressEvent) => void): void {
    this.emitter.once('progress', handler);
  }
}
