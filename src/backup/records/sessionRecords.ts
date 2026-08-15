// 备份 records 的 wire DTO:显式 camelCase 字段,纯类型与映射,不碰文件、数据库与状态冻结。
// 规则:本文件只定义形状;超过 500 行再按 conversation/execution/context 三组拆。

// ── 清单与警告 ──────────────────────────────────────────────────────────────

export interface OmittedBackupFile {
  readonly kind: 'attachment' | 'audio' | 'backgroundProcessOutput';
  readonly id: string;
  readonly reason: 'missing' | 'unreadable';
}

export interface SessionBackupManifest {
  readonly format: 'ema-session';
  readonly version: 2;
  readonly sessionId: string;
  readonly exportedAt: number;
  readonly generator: string;
  /** 导出时已缺失/不可读而省略的文件;不含绝对路径。 */
  readonly warnings: readonly OmittedBackupFile[];
}

// ── conversation 组 ─────────────────────────────────────────────────────────

export interface SessionRecord {
  readonly id: string;
  readonly title: string;
  /** 导出时的来源工作区提示;导入时永不恢复为目标机工作目录。 */
  readonly sourceWorkspaceRoot: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastActivityAt: number;
  readonly archivedAt: number | null;
  readonly pinned: boolean;
  readonly pinnedAt: number | null;
  readonly groupLabel: string | null;
  readonly parentSessionId: string | null;
  readonly executionProfile: 'chat' | 'work';
  readonly narrativePolicy: 'auto' | 'always' | 'off';
  readonly preferredProviderConfigId: string | null;
  readonly preferredModelId: string | null;
}

export interface TurnRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly triggerType: 'userMessage' | 'backgroundProcessCompleted';
  readonly executionProfile: 'chat' | 'work';
  readonly narrativePolicy: 'auto' | 'always' | 'off';
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  readonly userInput: string;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly iterations: number;
  readonly usageInputTokens: number;
  readonly usageOutputTokens: number;
}

export interface MessageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly role: 'system' | 'user' | 'assistant';
  readonly kind: 'normal' | 'tool_results' | 'summary' | 'narrative_context';
  readonly blocksJson: string;
  readonly interrupted: boolean;
  readonly createdAt: number;
}

export interface AttachmentRecord {
  readonly id: string;
  readonly turnId: string;
  readonly kind: 'file' | 'image';
  readonly name: string;
  readonly mime: string;
  readonly byteSize: number;
  readonly sourceModifiedAt: number;
  readonly createdAt: number;
  /** ZIP 内 files/ 下的相对路径,由安全 ID 与清洗文件名构成。 */
  readonly filePath: string;
}

export interface AudioRecord {
  readonly turnId: string;
  readonly sessionId: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly durationMs: number | null;
  readonly segmentCount: number;
  readonly createdAt: number;
  readonly filePath: string;
}

export interface SessionNotesRecord {
  readonly body: string;
  readonly tokensAtLastUpdate: number;
  readonly updatedAt: number;
}

// ── execution 组 ────────────────────────────────────────────────────────────

export interface TaskRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly displayNumber: number;
  readonly subject: string;
  readonly description: string;
  readonly activeForm: string | null;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  readonly createdByTurnId: string;
  readonly completedByTurnId: string | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

export interface TaskDependencyRecord {
  readonly sessionId: string;
  readonly blockerTaskId: string;
  readonly blockedTaskId: string;
  readonly createdAt: number;
}

export interface AgentRunRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly parentTurnId: string;
  readonly parentAgentRunId: string | null;
  readonly taskId: string | null;
  readonly kind: 'subagent' | 'fork';
  readonly purpose: string | null;
  readonly providerConfigId: string | null;
  readonly modelId: string | null;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly error: string | null;
  readonly iterations: number | null;
  readonly toolCallCount: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly outputExcerpt: string | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

export interface AgentRunMessageRecord {
  readonly id: string;
  readonly agentRunId: string;
  readonly role: 'assistant' | 'tool_call' | 'tool_result' | 'reasoning';
  readonly contentJson: string;
  readonly sequence: number;
  readonly createdAt: number;
}

export interface ToolExecutionRecord {
  readonly callId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentRunId: string | null;
  readonly toolName: string;
  readonly status: 'prepared' | 'authorized' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BackgroundProcessRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly originTurnId: string | null;
  readonly toolCallId: string | null;
  readonly command: string;
  readonly description: string | null;
  readonly cwd: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'timedOut' | 'stopped' | 'interrupted';
  readonly timeoutMs: number;
  readonly version: number;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly exitCode: number | null;
  readonly terminationReason: string | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly outputTruncated: boolean;
  /** ZIP 内 files/ 下的输出目录(含 stdout.log/stderr.log),导入时重落到目标 Session 受控目录。 */
  readonly outputDirectoryPath: string;
  readonly completionClaimedAt: number | null;
  readonly continuationTurnId: string | null;
  readonly modelNotifiedAt: number | null;
}

// ── context 组 ──────────────────────────────────────────────────────────────

export interface UsageRecord {
  readonly id: string;
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly capability: 'llm' | 'vision' | 'embed' | 'rerank' | 'stt' | 'tts';
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly durationMs: number;
  readonly errorCode: string | null;
  readonly createdAt: number;
}

export interface KbActivationRecord {
  readonly id: string;
  readonly callId: string;
  readonly kbId: string;
  readonly assetId: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly createdAt: number;
}

export interface MemoryStateRecord {
  readonly sessionId: string;
  readonly surfacedJson: string;
  readonly overridesJson: string;
}
