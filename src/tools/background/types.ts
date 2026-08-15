import type {
  CommandOutputChunk,
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
  id: string;
  sessionId: string;
  originTurnId?: string;
  toolCallId?: string;
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
  /** 日志目录绝对路径(stdout.log/stderr.log 所在),供前端"在文件管理器中显示"。 */
  outputDir: string;
}

export interface BackgroundProcessOutput {
  process: BackgroundProcessSummary;
  stdout: string;
  stderr: string;
  nextCursor: string;
  hasMore: boolean;
}

export interface BackgroundCommandRequest {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  runner: CommandRunnerPort;
  command: string;
  description?: string;
  cwd: string;
  timeoutMs?: number;
  runInBackground?: boolean;
  waitSignal: AbortSignal;
  isSuccessfulExitCode(exitCode: number): boolean;
  /**
   * 交互等待期内的原始输出增量(转交后台后不再回调——
   * 此后输出归日志与 ProcessOutput 游标, 原调用的进度通道已随结果返回关闭)。
   */
  onOutput?: (chunk: CommandOutputChunk) => void;
}

export type BackgroundCommandResult =
  | {
      kind: 'commandResult';
      result: CommandRunResult;
      durationMs: number;
    }
  | {
      kind: 'processReference';
      backgroundProcessId: string;
      status: 'queued' | 'running';
      outputPreview: string;
      /** 日志落盘位置(相对数据目录), 供模型后续 Read 完整输出。 */
      outputRelativePath: string;
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
    sessionId: string,
    options?: BackgroundProcessListOptions,
  ): BackgroundProcessSummary[];
  readOutput(
    sessionId: string,
    id: string,
    options?: BackgroundProcessOutputOptions,
  ): Promise<BackgroundProcessOutput>;
  /** 停止请求会在进程退出后返回真实终态快照。 */
  stop(sessionId: string, id: string): Promise<BackgroundProcessSummary>;
}

export interface BackgroundProcessOutputLocation {
  absoluteDirectory: string;
  relativeDirectory: string;
}

export type BackgroundProcessOutputPathFactory = (
  sessionId: string,
  processId: string,
) => BackgroundProcessOutputLocation;

/** 读取期把行内存储的相对路径解析为当前数据目录下的绝对位置。 */
export type BackgroundProcessOutputLocationResolver = (
  relativeDirectory: string,
) => BackgroundProcessOutputLocation;

export interface BackgroundProcessCompletion {
  processId: string;
  originTurnId?: string;
  status: BackgroundProcessNotifiableStatus;
  exitCode?: number;
  command: string;
  outputPreview: string;
}

export interface BackgroundProcessCompletionClaim {
  continuationTurnId: string;
  completions: BackgroundProcessCompletion[];
}

/** Server 用它把进程自然终态转换为内部 Turn；模型工具看不到领取能力。 */
export interface BackgroundProcessCompletionSource {
  setCompletionListener(listener?: (sessionId: string) => void): void;
  pendingCompletionSessions(): string[];
  claimCompletionBatch(
    sessionId: string,
    continuationTurnId: string,
  ): BackgroundProcessCompletionClaim | undefined;
  markCompletionDelivered(continuationTurnId: string): number;
}
