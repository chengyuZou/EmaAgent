import type {
  BackgroundProcessId,
  SessionId,
  ToolCallId,
  TurnId,
} from '@ema-agent/ids';
import type {
  CommandRunResult,
  CommandRunnerPort,
} from '@ema-agent/sandbox';

export type BackgroundProcessStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timedOut'
  | 'stopped'
  | 'interrupted';

export type BackgroundProcessNotifiableStatus =
  | 'completed'
  | 'failed'
  | 'timedOut';

export interface BackgroundProcessSettings {
  maxConcurrent: number;
  maxRuntimeHours: number;
}

export interface BackgroundProcessSummary {
  id: BackgroundProcessId;
  sessionId: SessionId;
  originTurnId?: TurnId;
  toolCallId?: ToolCallId;
  command: string;
  description?: string;
  cwd: string;
  status: BackgroundProcessStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs: number;
  exitCode?: number;
  terminationReason?: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
}

export interface BackgroundProcessOutput {
  process: BackgroundProcessSummary;
  stdout: string;
  stderr: string;
  nextCursor: string;
  hasMore: boolean;
}

export interface BackgroundCommandRequest {
  sessionId: SessionId;
  turnId: TurnId;
  toolCallId: ToolCallId;
  runner: CommandRunnerPort;
  command: string;
  description?: string;
  cwd: string;
  timeoutMs?: number;
  runInBackground?: boolean;
  waitSignal: AbortSignal;
  isSuccessfulExitCode(exitCode: number): boolean;
}

export type BackgroundCommandResult =
  | {
      kind: 'commandResult';
      result: CommandRunResult;
      durationMs: number;
    }
  | {
      kind: 'processReference';
      backgroundProcessId: BackgroundProcessId;
      status: 'queued' | 'running';
      outputPreview: string;
    };

export interface BackgroundProcessListOptions {
  status?: BackgroundProcessStatus;
  limit?: number;
}

export interface BackgroundProcessOutputOptions {
  cursor?: string;
  waitMs?: number;
}

/** Bash 与 Process 工具只依赖这项窄能力，不直接接触 Repo、文件路径或调度器。 */
export interface BackgroundProcessPort {
  runCommand(request: BackgroundCommandRequest): Promise<BackgroundCommandResult>;
  list(
    sessionId: SessionId,
    options?: BackgroundProcessListOptions,
  ): BackgroundProcessSummary[];
  readOutput(
    sessionId: SessionId,
    id: BackgroundProcessId,
    options?: BackgroundProcessOutputOptions,
  ): Promise<BackgroundProcessOutput>;
  stop(sessionId: SessionId, id: BackgroundProcessId): BackgroundProcessSummary;
}

export interface BackgroundProcessOutputLocation {
  absoluteDirectory: string;
  relativeDirectory: string;
}

export type BackgroundProcessOutputPathFactory = (
  sessionId: SessionId,
  processId: BackgroundProcessId,
) => BackgroundProcessOutputLocation;

export interface BackgroundProcessCompletion {
  processId: BackgroundProcessId;
  originTurnId?: TurnId;
  status: BackgroundProcessNotifiableStatus;
  exitCode?: number;
  command: string;
  outputPreview: string;
}

export interface BackgroundProcessCompletionClaim {
  continuationTurnId: TurnId;
  completions: BackgroundProcessCompletion[];
}

/** LocalHost 用它把进程自然终态转换为内部 Turn；模型工具看不到领取能力。 */
export interface BackgroundProcessCompletionSource {
  setCompletionListener(listener?: (sessionId: SessionId) => void): void;
  pendingCompletionSessions(): SessionId[];
  claimCompletionBatch(
    sessionId: SessionId,
    continuationTurnId: TurnId,
  ): BackgroundProcessCompletionClaim | undefined;
  markCompletionDelivered(continuationTurnId: TurnId): number;
}
