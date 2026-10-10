// 定义 Session ZIP 的记录结构，并在导入外部归档时执行基础字段校验。
import { z } from 'zod';

const id = z.string().min(1);
const nullableId = id.nullable();
const integer = z.number().int();
const nonNegativeInteger = integer.nonnegative();

export const omittedSessionFileSchema = z.object({
  kind: z.enum(['attachment', 'speechOutput', 'backgroundProcessOutput']),
  id,
  reason: z.enum(['missing', 'unreadable']),
}).strict();

export const sessionBackupManifestSchema = z.object({
  format: z.literal('ema-session'),
  version: z.literal(7),
  sessionId: id,
  omittedFiles: z.array(omittedSessionFileSchema),
}).strict();

export const sessionRecordSchema = z.object({
  id,
  title: z.string(),
  cwd: z.string().min(1),
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
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']),
  sessionMode: z.enum(['chat', 'work']),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']),
  ttsEnabled: z.boolean(),
}).strict().refine(
  value => (value.providerId === null) === (value.modelId === null),
  { message: 'Session 模型选择必须同时包含 Provider 和 Model' },
);

export const turnRecordSchema = z.object({
  id,
  sessionId: id,
  status: z.enum(['running', 'completed', 'failed', 'aborted']),
  triggerType: z.enum(['userMessage', 'sessionContinuation']),
  sessionMode: z.enum(['chat', 'work']),
  ttsEnabled: z.boolean(),
  providerId: nullableId,
  modelId: nullableId,
  // 与 provider_id/model_id 同生命周期：三者同时存在或同时缺省；开发期格式不兼容缺失该键的旧 ZIP。
  protocol: nullableId,
  characterName: z.string().nullable(),
  iterations: nonNegativeInteger,
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
  role: z.enum(['user', 'assistant']),
  kind: z.enum(['normal', 'tool_results', 'summary', 'reminder', 'continuation']),
  blocksJson: z.string(),
  interrupted: z.boolean(),
  createdAt: integer,
  // summary 必须携带覆盖截止游标，其他 kind 必须为 null；开发期不兼容缺失游标的旧 ZIP。
  summarizedThroughMessageId: nullableId,
  // 与消息正文同属摘要记录; 未记录 Token 减少量的摘要没有此字段.
  savedTokens: nonNegativeInteger.optional(),
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
  if (value.kind !== 'summary' && value.savedTokens !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: '非 summary 消息不能携带 savedTokens',
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

export const goalRecordSchema = z.object({
  id,
  sessionId: id,
  objective: z.string().min(1),
  feedback: z.string().nullable(),
  status: z.enum(['active', 'paused', 'completed']),
  version: integer.positive(),
  reason: z.enum(['succeeded', 'failed', 'cancelled']).nullable(),
  error: z.string().nullable(),
  createdAt: integer,
  updatedAt: integer,
  completedAt: integer.nullable(),
}).strict().superRefine((goal, ctx) => {
  if (goal.status !== 'completed') {
    if (goal.reason !== null || goal.error !== null || goal.completedAt !== null) {
      ctx.addIssue({ code: 'custom', message: '未完成 Goal 不能携带终态字段' });
    }
    return;
  }
  if (goal.reason === null || goal.completedAt === null) {
    ctx.addIssue({ code: 'custom', message: '已完成 Goal 缺少终态原因或时间' });
  }
  if ((goal.reason === 'failed') !== (goal.error !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Goal 错误必须与 failed 原因一致' });
  }
});

export const subagentRecordSchema = z.object({
  id,
  sessionId: id,
  title: z.string().nullable(),
  description: z.string().nullable(),
  // 身份保留最近一次实际配置; 每次执行的配置另存 subagentRuns.
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).nullable(),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']).nullable(),
  providerId: nullableId,
  modelId: nullableId,
  protocol: nullableId,
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  createdAt: integer,
  updatedAt: integer,
}).strict();

export const subagentRunRecordSchema = z.object({
  id,
  subagentId: id,
  parentToolCallId: nullableId,
  contextMode: z.enum(['subagent', 'fork']),
  description: z.string().nullable(),
  providerId: nullableId,
  modelId: nullableId,
  protocol: nullableId,
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).nullable(),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']).nullable(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  error: z.string().nullable(),
  iterations: nonNegativeInteger.nullable(),
  toolCallCount: nonNegativeInteger.nullable(),
  inputTokens: nonNegativeInteger.nullable(),
  outputTokens: nonNegativeInteger.nullable(),
  finalText: z.string().nullable(),
  createdAt: integer,
  updatedAt: integer,
  completedAt: integer.nullable(),
}).strict();

export const subagentMessageRecordSchema = z.object({
  id,
  subagentId: id,
  // fork 从父 Session 复制来的消息不属于子代理 Run, 原样保留 null.
  runId: nullableId,
  role: z.enum(['user', 'assistant']),
  kind: z.enum(['normal', 'tool_results', 'summary', 'continuation', 'reminder']),
  blocksJson: z.string(),
  interrupted: z.boolean(),
  createdAt: integer,
  summarizedThroughMessageId: nullableId,
  savedTokens: nonNegativeInteger.optional(),
  // 只保存消息表实际写入的来源, 不把 Run 查询出来的来源重复写进消息.
  providerId: nullableId,
  modelId: nullableId,
  protocol: nullableId,
}).strict().superRefine((message, ctx) => {
  if (message.kind !== 'summary' && message.summarizedThroughMessageId !== null) {
    ctx.addIssue({ code: 'custom', message: '非 summary 子消息不能携带摘要覆盖游标' });
  }
  if (message.kind !== 'summary' && message.savedTokens !== undefined) {
    ctx.addIssue({ code: 'custom', message: '非 summary 子消息不能携带 savedTokens' });
  }
  // fork 复制的摘要找不到旧覆盖消息时, 游标可以为 null, 以摘要自身为边界.
});

export const toolExecutionRecordSchema = z.object({
  callId: id,
  sessionId: id,
  turnId: id,
  subagentId: nullableId,
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
}).strict();

// 附件账本的归档记录。path 即身份(全局唯一):uuid 文件名不变,跨机器导入时
// 由导入方重写数据根前缀生成新 path。vision 描述缓存不进包(可再生)。
export const attachmentImageRecordSchema = z.object({
  path: id,
  turnId: nullableId,
  name: z.string().nullable(),
  byteSize: nonNegativeInteger,
  createdAt: integer,
  filePath: z.string(),
}).strict();

export const attachmentPastedTextRecordSchema = z.object({
  path: id,
  turnId: nullableId,
  byteSize: nonNegativeInteger,
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
export type GoalRecord = z.infer<typeof goalRecordSchema>;
export type SubagentRecord = z.infer<typeof subagentRecordSchema>;
export type SubagentRunRecord = z.infer<typeof subagentRunRecordSchema>;
export type SubagentMessageRecord = z.infer<typeof subagentMessageRecordSchema>;
export type ToolExecutionRecord = z.infer<typeof toolExecutionRecordSchema>;
export type BackgroundProcessRecord = z.infer<typeof backgroundProcessRecordSchema>;
export type AttachmentImageRecord = z.infer<typeof attachmentImageRecordSchema>;
export type AttachmentPastedTextRecord = z.infer<typeof attachmentPastedTextRecordSchema>;
export type SpeechOutputRecord = z.infer<typeof speechOutputRecordSchema>;
export type UsageRecord = z.infer<typeof usageRecordSchema>;
