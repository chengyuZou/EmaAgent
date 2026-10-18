import fs from 'node:fs';
import type { ZodType } from 'zod';
import type { SessionBackupReader, SessionBackupRestorer } from '@ema-agent/storage';
import { SessionImportError } from '../errors.js';
import {
  SESSION_MANIFEST_PATH,
  SESSION_RECORD_PATHS,
  isSessionArchivePath,
  type SessionRecordName,
} from '../records/sessionFormat.js';
import { readJsonl } from '../records/jsonl.js';
import {
  subagentMessageRecordSchema,
  subagentRecordSchema,
  subagentRunRecordSchema,
  attachmentImageRecordSchema,
  attachmentPastedTextRecordSchema,
  backgroundProcessRecordSchema,
  goalRecordSchema,
  messageRecordSchema,
  sessionBackupManifestSchema,
  sessionRecordSchema,
  speechOutputRecordSchema,
  taskRecordSchema,
  toolExecutionRecordSchema,
  turnRecordSchema,
  usageRecordSchema,
} from '../records/sessionRecords.js';
import {
  restoreSubagentMessageRecord,
  restoreSubagentRecord,
  restoreSubagentRunRecord,
  restoreAttachmentImageRecord,
  restoreAttachmentPastedTextRecord,
  restoreBackgroundProcessRecord,
  restoreGoalRecord,
  restoreMessageRecord,
  restoreSessionRecord,
  restoreSpeechOutputRecord,
  restoreTaskRecord,
  restoreToolExecutionRecord,
  restoreTurnRecord,
  restoreUsageRecord,
} from '../records/importMappings.js';
import type {
  MessageRecord,
  SubagentRecord,
  SubagentRunRecord,
  SubagentMessageRecord,
} from '../records/sessionRecords.js';
import type { SessionImportResult } from '../types.js';
import { extractSessionArchive, type ExtractedSessionArchive } from './archive.js';
import { publishSessionFiles } from './sessionFiles.js';

export async function importSessionArchive(
  filePath: string,
  activeDataDir: string,
  temporaryRoot: string,
  reader: SessionBackupReader,
  restorer: SessionBackupRestorer,
  modelSelectionExists: (providerId: string, modelId: string) => boolean,
  signal?: AbortSignal,
): Promise<SessionImportResult> {
  const archive = await extractSessionArchive(filePath, temporaryRoot, signal);
  try {
    const manifest = readJsonRecord(archive, SESSION_MANIFEST_PATH, sessionBackupManifestSchema);
    for (const entryPath of archive.paths()) {
      if (!isSessionArchivePath(entryPath)) {
        throw new SessionImportError('invalid_format', `ZIP 包含未知条目: ${entryPath}`);
      }
    }
    if (reader.hasSession(manifest.sessionId)) {
      throw new SessionImportError('destination_conflict', '同 id 的 Session 已存在', 409);
    }

    const session = readJsonRecord(archive, SESSION_RECORD_PATHS.session, sessionRecordSchema);
    if (session.id !== manifest.sessionId) {
      throw new SessionImportError('invalid_format', 'manifest 与 Session id 不一致');
    }
    const [
      turns, messages, tasks, goals, subagents, subagentRuns, subagentMessages,
      toolExecutions, backgroundProcesses, attachmentImages, attachmentPastedTexts,
      speechOutputs, usageRecords,
    ] = await Promise.all([
      readJsonlRecords(archive, 'turns', turnRecordSchema),
      readJsonlRecords(archive, 'messages', messageRecordSchema),
      readJsonlRecords(archive, 'tasks', taskRecordSchema),
      readJsonlRecords(archive, 'goals', goalRecordSchema),
      readJsonlRecords(archive, 'subagents', subagentRecordSchema),
      readJsonlRecords(archive, 'subagentRuns', subagentRunRecordSchema),
      readJsonlRecords(archive, 'subagentMessages', subagentMessageRecordSchema),
      readJsonlRecords(archive, 'toolExecutions', toolExecutionRecordSchema),
      readJsonlRecords(archive, 'backgroundProcesses', backgroundProcessRecordSchema),
      readJsonlRecords(archive, 'attachmentImages', attachmentImageRecordSchema),
      readJsonlRecords(archive, 'attachmentPastedTexts', attachmentPastedTextRecordSchema),
      readJsonlRecords(archive, 'speechOutputs', speechOutputRecordSchema),
      readJsonlRecords(archive, 'usageRecords', usageRecordSchema),
    ]);
    throwIfCancelled(signal);
    assertSessionOwnership(manifest.sessionId, [
      ['turns', turns],
      ['messages', messages],
      ['tasks', tasks],
      ['goals', goals],
      ['subagents', subagents],
      ['toolExecutions', toolExecutions],
      ['backgroundProcesses', backgroundProcesses],
      ['speechOutputs', speechOutputs],
      ['usageRecords', usageRecords],
    ]);
    assertSubagentReferences(subagents, subagentRuns, subagentMessages);
    if (session.permissionMode === 'plan' && goals.some(goal => goal.status !== 'completed')) {
      throw new SessionImportError('invalid_format', 'Plan Session 不能包含未完成 Goal');
    }
    if (goals.filter(goal => goal.status !== 'completed').length > 1) {
      throw new SessionImportError('invalid_format', 'Session 不能包含多个未完成 Goal');
    }
    assertSummaryCursors(messages);

    const warnings = manifest.omittedFiles.map(file => `${file.kind}:${file.id} 未包含文件内容`);
    const importedAt = Date.now();
    const restoredSession = restoreSessionRecord(session);
    if (
      restoredSession.provider_id !== null
      && restoredSession.model_id !== null
      && !modelSelectionExists(restoredSession.provider_id, restoredSession.model_id)
    ) {
      restoredSession.provider_id = null;
      restoredSession.model_id = null;
      warnings.push('原 Session 的模型在当前安装中不可用, 已清除模型选择');
    }

    // 先发布完整文件, 再恢复数据库. 数据库失败时只删除本次新建的目录.
    const files = publishSessionFiles(
      activeDataDir,
      manifest.sessionId,
      archive,
      attachmentImages,
      attachmentPastedTexts,
      speechOutputs,
      backgroundProcesses,
      signal,
    );
    try {
      // 消息块中的受管附件路径随文件一起改变; 用户引用的外部文件路径不动.
      restorer.restoreSession({
        session: restoredSession,
        turns: turns.map(row => restoreTurnRecord(row, importedAt)),
        messages: messages.map(record => restoreMessageRecord({
          ...record,
          blocksJson: rewriteAttachmentPaths(record.blocksJson, files.attachments),
        })),
        tasks: tasks.map(restoreTaskRecord),
        goals: goals.map(goal => restoreGoalRecord(goal, importedAt)),
        subagents: subagents.map(row => restoreSubagentRecord(row, importedAt)),
        subagentRuns: subagentRuns.map(row => restoreSubagentRunRecord(row, importedAt)),
        subagentMessages: subagentMessages.map(record => restoreSubagentMessageRecord({
          ...record,
          blocksJson: rewriteAttachmentPaths(record.blocksJson, files.attachments),
        })),
        toolExecutions: toolExecutions.map(row => restoreToolExecutionRecord(row, importedAt)),
        backgroundProcesses: backgroundProcesses.map(row => restoreBackgroundProcessRecord(
          row,
          files.backgroundDirectories.get(row.id) ?? `sessions/${manifest.sessionId}/background-processes/${row.id}`,
          archiveOutputBytes(archive, row.outputDirectoryPath, 'stdout.log'),
          archiveOutputBytes(archive, row.outputDirectoryPath, 'stderr.log'),
          importedAt,
        )),
        attachmentImages: attachmentImages.flatMap(row => {
          const newPath = files.attachments.get(row.path);
          return newPath
            ? [restoreAttachmentImageRecord(row, newPath, manifest.sessionId)]
            : [];
        }),
        attachmentPastedTexts: attachmentPastedTexts.flatMap(row => {
          const newPath = files.attachments.get(row.path);
          return newPath
            ? [restoreAttachmentPastedTextRecord(row, newPath, manifest.sessionId)]
            : [];
        }),
        speechOutputs: speechOutputs.flatMap(row => {
          const filePath = files.speechOutputs.get(row.filePath);
          return filePath ? [restoreSpeechOutputRecord(row, filePath)] : [];
        }),
        usageRecords: usageRecords.map(restoreUsageRecord),
      });
    } catch (error) {
      // publishSessionFiles 只返回本次新建的目录, 不会返回已有 Session 目录.
      fs.rmSync(files.directory, { recursive: true, force: true });
      throw new SessionImportError(
        'restore_failed',
        error instanceof Error ? error.message : 'Session 数据库恢复失败',
        500,
      );
    }
    return { sessionId: manifest.sessionId, warnings };
  } finally {
    archive.dispose();
  }
}

function rewriteAttachmentPaths(
  blocksJson: string,
  pathMap: ReadonlyMap<string, string>,
): string {
  let rewritten = blocksJson;
  for (const [oldPath, newPath] of pathMap) {
    if (oldPath === newPath) {
      continue;
    }
    // blocks_json 中的 Windows 路径已经过 JSON 转义, 原始反斜杠不能直接匹配.
    const escapedOld = JSON.stringify(oldPath).slice(1, -1);
    const escapedNew = JSON.stringify(newPath).slice(1, -1);
    rewritten = rewritten.split(escapedOld).join(escapedNew);
  }
  return rewritten;
}

function readJsonRecord<T>(
  archive: ExtractedSessionArchive,
  entryPath: string,
  schema: ZodType<T>,
): T {
  const entry = archive.require(entryPath);
  try {
    return schema.parse(JSON.parse(fs.readFileSync(entry.filePath, 'utf8')));
  } catch (error) {
    throw invalidRecord(entryPath, error);
  }
}

async function readJsonlRecords<T>(
  archive: ExtractedSessionArchive,
  name: Exclude<SessionRecordName, 'session'>,
  schema: ZodType<T>,
): Promise<T[]> {
  const entry = archive.require(SESSION_RECORD_PATHS[name]);
  const records: T[] = [];
  try {
    for await (const record of readJsonl(entry.filePath, value => schema.parse(value))) {
      records.push(record);
    }
    return records;
  } catch (error) {
    throw invalidRecord(name, error);
  }
}

function invalidRecord(name: string, error: unknown): SessionImportError {
  const message = error instanceof Error ? error.message : String(error);
  return new SessionImportError('invalid_format', `${name} 记录无效: ${message}`);
}

function assertSessionOwnership(
  sessionId: string,
  groups: readonly (readonly [name: string, records: readonly { sessionId: string }[]])[],
): void {
  for (const [name, records] of groups) {
    if (records.some(record => record.sessionId !== sessionId)) {
      throw new SessionImportError('invalid_format', `${name} 包含其他 Session 的记录`);
    }
  }
}

/** 每个 Summary 的覆盖截止游标必须指向本次归档中的同 Session 消息. */
function assertSummaryCursors(messages: readonly MessageRecord[]): void {
  const messageIds = new Set(messages.map(message => message.id));
  for (const message of messages) {
    if (message.kind !== 'summary') {
      continue;
    }
    if (message.summarizedThroughMessageId === null) {
      throw new SessionImportError(
        'invalid_format',
        `summary 消息 ${message.id} 缺少覆盖截止游标`,
      );
    }
    if (!messageIds.has(message.summarizedThroughMessageId)) {
      throw new SessionImportError(
        'invalid_format',
        `summary 消息 ${message.id} 的覆盖截止游标不在本次归档的 messages 中`,
      );
    }
  }
}

/** 子消息只能属于自己的身份和 Run; 摘要游标不能指向别的子代理历史. */
function assertSubagentReferences(
  subagents: readonly SubagentRecord[],
  runs: readonly SubagentRunRecord[],
  messages: readonly SubagentMessageRecord[],
): void {
  const subagentIds = new Set(subagents.map(subagent => subagent.id));
  const runsById = new Map(runs.map(run => [run.id, run]));
  const messagesById = new Map(messages.map(message => [message.id, message]));
  for (const run of runs) {
    if (!subagentIds.has(run.subagentId)) {
      throw new SessionImportError('invalid_format', `Run ${run.id} 引用了归档外的子代理`);
    }
  }
  for (const message of messages) {
    if (!subagentIds.has(message.subagentId)) {
      throw new SessionImportError('invalid_format', `子消息 ${message.id} 引用了归档外的子代理`);
    }
    if (message.runId !== null) {
      const run = runsById.get(message.runId);
      if (!run || run.subagentId !== message.subagentId) {
        throw new SessionImportError('invalid_format', `子消息 ${message.id} 的 Run 不存在或属于其他子代理`);
      }
    }
    if (message.kind !== 'summary' || message.summarizedThroughMessageId === null) {
      continue;
    }
    const through = messagesById.get(message.summarizedThroughMessageId);
    if (!through || through.subagentId !== message.subagentId) {
      throw new SessionImportError('invalid_format', `子摘要 ${message.id} 的覆盖游标不在本子代理归档中`);
    }
    if (through.createdAt > message.createdAt
      || (through.createdAt === message.createdAt && through.id >= message.id)) {
      throw new SessionImportError('invalid_format', `子摘要 ${message.id} 的覆盖游标必须早于摘要`);
    }
  }
}

function archiveOutputBytes(archive: ExtractedSessionArchive, root: string, name: string): number {
  return archive.get(`${root}/${name}`)?.size ?? 0;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SessionImportError('import_cancelled', 'Session 导入已取消', 499);
  }
}
