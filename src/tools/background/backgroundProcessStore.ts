// 后台进程持久化的窄端口:Tools 拥有状态语义,Storage 以原子操作实现它。
import type {
  BackgroundProcessId,
  SessionId,
  ToolCallId,
  TurnId,
} from '@ema-agent/ids';
import type { BackgroundProcessStatus } from './types.js';

/** 持久化一行的领域形状;不出现 SQL 列名与 null。 */
export interface BackgroundProcessRecord {
  id: BackgroundProcessId;
  sessionId: SessionId;
  originTurnId?: TurnId;
  toolCallId?: ToolCallId;
  command: string;
  description?: string;
  cwd: string;
  status: BackgroundProcessStatus;
  timeoutMs: number;
  version: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  terminationReason?: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
  /** 日志目录的相对路径(相对数据目录),是日志位置的唯一事实源。 */
  outputRelativePath: string;
  completionClaimedAt?: number;
  continuationTurnId?: TurnId;
  modelNotifiedAt?: number;
}

export interface BackgroundProcessInsertRecord {
  id: BackgroundProcessId;
  sessionId: SessionId;
  originTurnId: TurnId;
  toolCallId: ToolCallId;
  command: string;
  description?: string;
  cwd: string;
  status: 'queued' | 'running';
  timeoutMs: number;
  outputRelativePath: string;
  createdAt: number;
  startedAt?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  outputTruncated?: boolean;
}

export interface BackgroundProcessTerminalRecord {
  status: 'completed' | 'failed' | 'timedOut' | 'stopped' | 'interrupted';
  completedAt: number;
  exitCode?: number;
  terminationReason?: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
}

export interface BackgroundProcessListFilter {
  status?: BackgroundProcessStatus;
  limit?: number;
}

/**
 * Runtime 只通过这些原子操作读写持久状态;调度、通知与恢复语义留在 Tools。
 * SQL 实现是 Storage 的 BackgroundProcessesRepo,由 Core 装配注入。
 */
export interface BackgroundProcessStore {
  insert(value: BackgroundProcessInsertRecord): BackgroundProcessRecord;
  findById(id: BackgroundProcessId): BackgroundProcessRecord | undefined;
  listForSession(
    sessionId: SessionId,
    filter?: BackgroundProcessListFilter,
  ): BackgroundProcessRecord[];
  transitionToRunning(
    id: BackgroundProcessId,
    expectedVersion: number,
    startedAt: number,
  ): BackgroundProcessRecord | undefined;
  finish(
    id: BackgroundProcessId,
    expectedVersion: number,
    terminal: BackgroundProcessTerminalRecord,
  ): BackgroundProcessRecord | undefined;
  recoverInterrupted(at: number): BackgroundProcessRecord[];
  claimCompletionBatch(
    sessionId: SessionId,
    continuationTurnId: TurnId,
    at: number,
  ): BackgroundProcessRecord[];
  markCompletionDelivered(continuationTurnId: TurnId, at: number): number;
  listSessionsWithPendingCompletions(): SessionId[];
}
