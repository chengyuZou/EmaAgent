// 定义 Session ZIP 的记录结构，并在导入外部归档时执行基础字段校验。
import { z } from 'zod';

const id = z.string().min(1);
const nullableId = id.nullable();
const integer = z.number().int();
const nonNegativeInteger = integer.nonnegative();

export const omittedSessionFileSchema = z.object({
  kind: z.enum(['attachment', 'speechOutput', 'speechSegment', 'backgroundProcessOutput']),
  id,
  reason: z.enum(['missing', 'unreadable']),
}).strict();

export const sessionBackupManifestSchema = z.object({
  format: z.literal('ema-session'),
  version: z.literal(1),
  sessionId: id,
  omittedFiles: z.array(omittedSessionFileSchema),
}).strict();

export const sessionRecordSchema = z.object({
  id,
  title: z.string(),
  workspaceRoot: z.string().nullable(),
  projectId: nullableId,
  pinned: z.boolean(),
  archivedAt: integer.nullable(),
  forkedFromSessionId: nullableId,
  forkedFromTurnId: nullableId,
  lastViewedAt: integer.nullable(),
  lastActivityAt: integer,
  createdAt: integer,
  updatedAt: integer,
  providerId: nullableId,
  modelId: nullableId,
  executionProfile: z.enum(['chat', 'work']),
  narrativePolicy: z.enum(['auto', 'always', 'off']),
}).strict().refine(
  value => (value.providerId === null) === (value.modelId === null),
  { message: 'Session 模型选择必须同时包含 Provider 和 Model' },
);

export const turnRecordSchema = z.object({
  id,
  sessionId: id,
  status: z.enum(['running', 'completed', 'failed', 'aborted']),
  triggerType: z.enum(['userMessage', 'backgroundProcessCompleted']),
  executionProfile: z.enum(['chat', 'work']),
  narrativePolicy: z.enum(['auto', 'always', 'off']),
  providerId: nullableId,
  modelId: nullableId,
  // 与 provider_id/model_id 同生命周期：三者同时存在或同时缺省；开发期格式不兼容缺失该键的旧 ZIP。
  protocol: nullableId,
  characterDirectoryName: z.string().nullable(),
  iterations: nonNegativeInteger,
  usageInputTokens: nonNegativeInteger,
  usageOutputTokens: nonNegativeInteger,
  createdAt: integer,
  completedAt: integer.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
}).strict().refine(
  value => (value.providerId === null) === (value.modelId === null)
    && (value.modelId === null) === (value.protocol === null),
  { message: 'Turn 模型选择必须同时包含或同时缺省 Provider/Model/Protocol' },
);

export const messageRecordSchema = z.object({
  id,
  sessionId: id,
  turnId: nullableId,
  role: z.enum(['system', 'user', 'assistant']),
  kind: z.enum(['normal', 'tool_results', 'summary', 'reminder']),
  blocksJson: z.string(),
  interrupted: z.boolean(),
  createdAt: integer,
  // summary 必须携带覆盖截止游标，其他 kind 必须为 null；开发期不兼容缺失游标的旧 ZIP。
  summarizedThroughMessageId: nullableId,
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'summary' && value.summarizedThroughMessageId === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'summary 消息必须携带覆盖截止游标 summarizedThroughMessageId',
    });
  }
  if (value.kind !== 'summary' && value.summarizedThroughMessageId !== null) {
    ctx.addIssue({
      code: 'custom',
      message: '非 summary 消息不能携带覆盖截止游标 summarizedThroughMessageId',
    });
  }
});

export const taskRecordSchema = z.object({
  id,
  sessionId: id,
  displayNumber: integer.positive(),
  subject: z.string(),
  description: z.string(),
  activeForm: z.string().nullable(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  createdByTurnId: id,
  completedByTurnId: nullableId,
  version: nonNegativeInteger,
  createdAt: integer,
  updatedAt: integer,
  completedAt: integer.nullable(),
}).strict();

export const agentRunRecordSchema = z.object({
  id,
  sessionId: id,
  parentTurnId: id,
  parentAgentRunId: nullableId,
  contextMode: z.enum(['subagent', 'fork']),
  description: z.string().nullable(),
  providerId: nullableId,
  modelId: nullableId,
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  error: z.string().nullable(),
  iterations: nonNegativeInteger.nullable(),
  toolCallCount: nonNegativeInteger.nullable(),
  inputTokens: nonNegativeInteger.nullable(),
  outputTokens: nonNegativeInteger.nullable(),
  outputExcerpt: z.string().nullable(),
  version: nonNegativeInteger,
  createdAt: integer,
  updatedAt: integer,
  completedAt: integer.nullable(),
}).strict();

export const agentRunMessageRecordSchema = z.object({
  id,
  agentRunId: id,
  role: z.enum(['assistant', 'tool_call', 'tool_result', 'reasoning']),
  contentJson: z.string(),
  sequence: nonNegativeInteger,
  createdAt: integer,
}).strict();

export const toolExecutionRecordSchema = z.object({
  callId: id,
  sessionId: id,
  turnId: id,
  agentRunId: nullableId,
  toolName: z.string().min(1),
  status: z.enum([
    'prepared', 'authorized', 'running', 'succeeded',
    'failed', 'cancelled', 'outcome_unknown',
  ]),
  startedAt: integer.nullable(),
  completedAt: integer.nullable(),
  version: nonNegativeInteger,
  createdAt: integer,
  updatedAt: integer,
}).strict();

export const backgroundProcessRecordSchema = z.object({
  id,
  sessionId: id,
  originTurnId: nullableId,
  toolCallId: nullableId,
  command: z.string(),
  description: z.string().nullable(),
  cwd: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'timedOut', 'stopped', 'interrupted']),
  timeoutMs: integer.positive(),
  version: nonNegativeInteger,
  createdAt: integer,
  startedAt: integer.nullable(),
  completedAt: integer.nullable(),
  exitCode: integer.nullable(),
  terminationReason: z.string().nullable(),
  stdoutBytes: nonNegativeInteger,
  stderrBytes: nonNegativeInteger,
  outputTruncated: z.boolean(),
  outputDirectoryPath: z.string(),
  completionClaimedAt: integer.nullable(),
  continuationTurnId: nullableId,
  modelNotifiedAt: integer.nullable(),
}).strict();

export const attachmentRecordSchema = z.object({
  id,
  turnId: id,
  sessionId: id,
  kind: z.enum(['file', 'image']),
  name: z.string(),
  mime: z.string(),
  byteSize: nonNegativeInteger,
  sourceModifiedAt: integer,
  createdAt: integer,
  filePath: z.string(),
}).strict();

export const speechOutputRecordSchema = z.object({
  turnId: id,
  sessionId: id,
  mimeType: z.string(),
  byteSize: nonNegativeInteger,
  durationMs: nonNegativeInteger.nullable(),
  segmentCount: nonNegativeInteger,
  createdAt: integer,
  filePath: z.string(),
}).strict();

export const speechSegmentRecordSchema = z.object({
  id,
  turnId: id,
  sessionId: id,
  sentenceIndex: nonNegativeInteger,
  mimeType: z.string(),
  byteSize: nonNegativeInteger,
  durationMs: nonNegativeInteger.nullable(),
  text: z.string(),
  createdAt: integer,
  filePath: z.string(),
}).strict();

export const usageRecordSchema = z.object({
  id,
  sessionId: id,
  turnId: nullableId,
  providerId: id,
  modelId: id,
  capability: z.enum(['llm', 'vision', 'embed', 'rerank', 'stt', 'tts']),
  status: z.enum(['completed', 'failed', 'cancelled']),
  inputTokens: nonNegativeInteger.nullable(),
  outputTokens: nonNegativeInteger.nullable(),
  cacheReadInputTokens: nonNegativeInteger.nullable(),
  cacheWriteInputTokens: nonNegativeInteger.nullable(),
  quantity: z.number().nonnegative().nullable(),
  unit: z.string().nullable(),
  durationMs: nonNegativeInteger,
  errorCode: z.string().nullable(),
  createdAt: integer,
}).strict();

export type OmittedSessionFile = z.infer<typeof omittedSessionFileSchema>;
export type SessionBackupManifest = z.infer<typeof sessionBackupManifestSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type TurnRecord = z.infer<typeof turnRecordSchema>;
export type MessageRecord = z.infer<typeof messageRecordSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type AgentRunRecord = z.infer<typeof agentRunRecordSchema>;
export type AgentRunMessageRecord = z.infer<typeof agentRunMessageRecordSchema>;
export type ToolExecutionRecord = z.infer<typeof toolExecutionRecordSchema>;
export type BackgroundProcessRecord = z.infer<typeof backgroundProcessRecordSchema>;
export type AttachmentRecord = z.infer<typeof attachmentRecordSchema>;
export type SpeechOutputRecord = z.infer<typeof speechOutputRecordSchema>;
export type SpeechSegmentRecord = z.infer<typeof speechSegmentRecordSchema>;
export type UsageRecord = z.infer<typeof usageRecordSchema>;
