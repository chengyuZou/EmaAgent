// 校验 Session 记录、发布文件并调用 Storage 单事务恢复数据库行。
import fs from 'node:fs';
import type { SessionBackupReader, SessionBackupRestorer } from '@ema-agent/storage';
import { SessionImportError } from '../errors.js';
import { SESSION_MANIFEST_PATH } from '../records/sessionFormat.js';
import {
  agentRunMessageRecordSchema,
  agentRunRecordSchema,
  attachmentRecordSchema,
  backgroundProcessRecordSchema,
  messageRecordSchema,
  sessionBackupManifestSchema,
  sessionRecordSchema,
  speechOutputRecordSchema,
  speechSegmentRecordSchema,
  taskRecordSchema,
  toolExecutionRecordSchema,
  turnRecordSchema,
  usageRecordSchema,
} from '../records/sessionRecords.js';
import {
  restoreAgentRunMessageRecord,
  restoreAgentRunRecord,
  restoreAttachmentRecord,
  restoreBackgroundProcessRecord,
  restoreMessageRecord,
  restoreSessionRecord,
  restoreSpeechOutputRecord,
  restoreSpeechSegmentRecord,
  restoreTaskRecord,
  restoreToolExecutionRecord,
  restoreTurnRecord,
  restoreUsageRecord,
} from '../records/importMappings.js';
import type { MessageRecord } from '../records/sessionRecords.js';
import type { BackupArchiveSource, SessionImportResult } from '../types.js';
import { extractSessionArchive } from './archive.js';
import { readJsonRecord, readJsonlRecords } from './recordReader.js';
import { publishSessionFiles } from './sessionFiles.js';

export async function importSessionArchive(
  source: BackupArchiveSource,
  activeDataDir: string,
  temporaryRoot: string,
  reader: SessionBackupReader,
  restorer: SessionBackupRestorer,
  modelSelectionExists: (providerId: string, modelId: string) => boolean,
  signal?: AbortSignal,
): Promise<SessionImportResult> {
  const archive = await extractSessionArchive(source, temporaryRoot, signal);
  try {
    const manifest = readManifest(archive.require(SESSION_MANIFEST_PATH).filePath);
    if (reader.hasSession(manifest.sessionId)) {
      throw new SessionImportError('destination_conflict', '同 id 的 Session 已存在', 409);
    }

    const session = readJsonRecord(archive, 'session', sessionRecordSchema);
    if (session.id !== manifest.sessionId) {
      throw new SessionImportError('invalid_format', 'manifest 与 Session id 不一致');
    }
    const [
      turns, messages, tasks, agentRuns, agentRunMessages,
      toolExecutions, backgroundProcesses, attachments, speechOutputs,
      speechSegments, usageRecords,
    ] = await Promise.all([
      readJsonlRecords(archive, 'turns', turnRecordSchema),
      readJsonlRecords(archive, 'messages', messageRecordSchema),
      readJsonlRecords(archive, 'tasks', taskRecordSchema),
      readJsonlRecords(archive, 'agentRuns', agentRunRecordSchema),
      readJsonlRecords(archive, 'agentRunMessages', agentRunMessageRecordSchema),
      readJsonlRecords(archive, 'toolExecutions', toolExecutionRecordSchema),
      readJsonlRecords(archive, 'backgroundProcesses', backgroundProcessRecordSchema),
      readJsonlRecords(archive, 'attachments', attachmentRecordSchema),
      readJsonlRecords(archive, 'speechOutputs', speechOutputRecordSchema),
      readJsonlRecords(archive, 'speechSegments', speechSegmentRecordSchema),
      readJsonlRecords(archive, 'usageRecords', usageRecordSchema),
    ]);
    throwIfCancelled(signal);
    assertSessionOwnership(manifest.sessionId, {
      turns, messages, tasks, agentRuns, toolExecutions,
      backgroundProcesses, attachments, speechOutputs, speechSegments,
      usageRecords,
    });
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
      warnings.push('原 Session 的模型在当前安装中不可用，已清除模型选择');
    }

    const files = publishSessionFiles(
      activeDataDir,
      manifest.sessionId,
      archive,
      attachments,
      speechOutputs,
      speechSegments,
      backgroundProcesses,
      signal,
    );
    try {
      restorer.restoreSession({
        session: restoredSession,
        turns: turns.map(row => restoreTurnRecord(row, importedAt)),
        messages: messages.map(restoreMessageRecord),
        tasks: tasks.map(restoreTaskRecord),
        agentRuns: agentRuns.map(row => restoreAgentRunRecord(row, importedAt)),
        agentRunMessages: agentRunMessages.map(restoreAgentRunMessageRecord),
        toolExecutions: toolExecutions.map(row => restoreToolExecutionRecord(row, importedAt)),
        backgroundProcesses: backgroundProcesses.map(row => restoreBackgroundProcessRecord(
          row,
          files.backgroundDirectories.get(row.id) ?? `sessions/${manifest.sessionId}/background-processes/${row.id}`,
          archiveOutputBytes(archive, row.outputDirectoryPath, 'stdout.log'),
          archiveOutputBytes(archive, row.outputDirectoryPath, 'stderr.log'),
          importedAt,
        )),
        attachments: attachments.flatMap(row => {
          const filePath = files.attachments.get(row.id);
          return filePath ? [restoreAttachmentRecord(row, filePath)] : [];
        }),
        speechOutputs: speechOutputs.flatMap(row => {
          const filePath = files.speechOutputs.get(row.turnId);
          return filePath ? [restoreSpeechOutputRecord(row, filePath)] : [];
        }),
        speechSegments: speechSegments.flatMap(row => {
          const filePath = files.speechSegments.get(row.id);
          return filePath ? [restoreSpeechSegmentRecord(row, filePath)] : [];
        }),
        usageRecords: usageRecords.map(restoreUsageRecord),
      });
      files.commit();
    } catch (error) {
      files.rollback();
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

function readManifest(filePath: string) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (value?.format === 'ema-session' && value.version !== 1) {
      throw new SessionImportError('unsupported_version', `不支持的 Session 备份版本: ${String(value.version)}`);
    }
    return sessionBackupManifestSchema.parse(value);
  } catch (error) {
    if (error instanceof SessionImportError) throw error;
    throw new SessionImportError(
      'invalid_format',
      error instanceof Error ? `manifest 无效: ${error.message}` : 'manifest 无效',
    );
  }
}

function assertSessionOwnership(sessionId: string, groups: Record<string, readonly { sessionId: string }[]>): void {
  for (const [name, records] of Object.entries(groups)) {
    if (records.some(record => record.sessionId !== sessionId)) {
      throw new SessionImportError('invalid_format', `${name} 包含其他 Session 的记录`);
    }
  }
}

/** 每个 Summary 的覆盖截止游标必须指向本次归档中的同 Session 消息。 */
function assertSummaryCursors(messages: readonly MessageRecord[]): void {
  const messageIds = new Set(messages.map(message => message.id));
  for (const message of messages) {
    if (message.kind !== 'summary') continue;
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

function archiveOutputBytes(archive: { get(path: string): { size: number } | null }, root: string, name: string): number {
  return archive.get(`${root}/${name}`)?.size ?? 0;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SessionImportError('import_cancelled', 'Session 导入已取消', 499);
}
