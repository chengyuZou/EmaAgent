import path from 'node:path';
import { LRUCache } from 'lru-cache';

const FILE_STATE_CACHE_MAX_ENTRIES = 100;
const FILE_STATE_CACHE_MAX_BYTES = 25 * 1024 * 1024;
const FILE_STATE_MIN_SIZE_BYTES = 1;

export interface FileState {
  /** 全文读取保存原文, 范围读取只保存已返回的切片. */
  content: string;
  /** 文件修改时间, 单位为毫秒. */
  timestamp: number;
  /** undefined 表示没有请求范围, 不使用默认行号代替. */
  offset?: number;
  limit?: number;
  totalLines: number;
  /** 上一次读取的正文超过输出预算, 不代表全文缓存缺少内容. */
  truncated: boolean;
}

/** Session 内保存最近读取或写入的文件状态, 不依赖消息历史. */
export class FileStateCache {
  private readonly cache = new LRUCache<string, FileState>({
    max: FILE_STATE_CACHE_MAX_ENTRIES,
    maxSize: FILE_STATE_CACHE_MAX_BYTES,
    sizeCalculation: state => Math.max(FILE_STATE_MIN_SIZE_BYTES, Buffer.byteLength(state.content, 'utf8')),
  });

  get(filePath: string): FileState | undefined {
    return this.cache.get(path.normalize(filePath));
  }

  set(filePath: string, state: FileState): void {
    this.cache.set(path.normalize(filePath), state);
  }

  clear(): void {
    this.cache.clear();
  }
}

/** 修改时间变新时, 只有完整原文可以证明文件内容没有变化. */
export function fileChangedSinceRead(state: FileState, mtimeMs: number, content: string): boolean {
  if (Math.floor(mtimeMs) <= Math.floor(state.timestamp)) {
    return false;
  }
  if (state.offset !== undefined || state.limit !== undefined) {
    return true;
  }
  return content.replace(/\r\n/g, '\n') !== state.content.replace(/\r\n/g, '\n');
}
