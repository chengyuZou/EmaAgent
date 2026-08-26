import type { MemoryExtractionJobKind } from '@ema-agent/storage';

export class MemoryNoteEmptyError extends Error {
  constructor() {
    super('Memory note cannot be empty');
    this.name = 'MemoryNoteEmptyError';
  }
}

export class MemoryNoteCharacterRequiredError extends Error {
  constructor() {
    super('Current character is required for a character memory note');
    this.name = 'MemoryNoteCharacterRequiredError';
  }
}

export class MemoryNoteAlreadyExistsError extends Error {
  constructor(readonly filePath: string) {
    super(`Memory note already exists: ${filePath}`);
    this.name = 'MemoryNoteAlreadyExistsError';
  }
}

/** 整合直调输出/应用失败的领域错误（path 越界、JSON 非法、白名单外等）。 */
export class MemoryConsolidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryConsolidationError';
  }
}

/** 安全候选清理完后仍超过物理硬上限，必须交给用户整理正式记忆。 */
export class MemoryStorageLimitExceededError extends Error {
  constructor(
    usedBytes: number,
    maxBytes: number,
  ) {
    super(`Memory storage still exceeds the limit: ${usedBytes}/${maxBytes} bytes`);
    this.name = 'MemoryStorageLimitExceededError';
  }
}

/** 用户编辑写到了正式记忆白名单之外（extensions/turn_evidence/.git/派生文件）。 */
export class MemoryFileNotEditableError extends Error {
  constructor(readonly path: string) {
    super(`Memory file is not user-editable: ${path}`);
    this.name = 'MemoryFileNotEditableError';
  }
}

/** 读取后文件已被改写（整合 Job 或外部编辑），保存方必须刷新后重试。 */
export class MemoryFileChangedError extends Error {
  constructor(readonly path: string) {
    super(`Memory file changed since read: ${path}`);
    this.name = 'MemoryFileChangedError';
  }
}

/**
 * 单条 Memory Job 入队失败的记录(两条提取 Job 分别独立入队,
 * 失败的那条没有 Job 行,必须靠 errors/事件暴露给用户)。
 */
export interface MemoryJobEnqueueError {
  /** 失败的是哪条提取轨。 */
  readonly kind: MemoryExtractionJobKind;
  /** 入队异常原文。 */
  readonly error: string;
}
