// 校验 Session 记录、发布文件并调用 Storage 单事务恢复数据库行。
//
// 导入三步, 崩溃语义逐级干净:
//   1. 解包到 staging(extractSessionArchive)
//   2. 附件文件写进 sessions/<sid>/attachments/...(uuid 名不变, publishSessionFiles)
//      —— 此时崩了:SQL 还没碰, 启动对账删掉这个无行目录
//   3. 单个 SQL 事务:session/turns/messages(块内路径已重写) + 两本账行
//      —— 此时崩了:事务自动回滚一行不留, 只剩文件夹, 启动对账再扫掉
// 必须先文件后 SQL:反过来的话事务已提交而文件写挂, 留下"有行没文件"
// 的半成品, 失败清理就得额外级联删行, 而不是永远只删文件夹一个动作。
import fs from 'node:fs';
import type { SessionBackupReader, SessionBackupRestorer } from '@ema-agent/storage';
import { SessionImportError } from '../errors.js';
import { SESSION_MANIFEST_PATH } from '../records/sessionFormat.js';
import {
  agentRunMessageRecordSchema,
  agentRunRecordSchema,
  attachmentImageRecordSchema,
  attachmentPastedTextRecordSchema,
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
  restoreAttachmentImageRecord,
  restoreAttachmentPastedTextRecord,
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
      toolExecutions, backgroundProcesses, attachmentImages, attachmentPastedTexts,
      speechOutputs, speechSegments, usageRecords,
    ] = await Promise.all([
      readJsonlRecords(archive, 'turns', turnRecordSchema),
      readJsonlRecords(archive, 'messages', messageRecordSchema),
      readJsonlRecords(archive, 'tasks', taskRecordSchema),
      readJsonlRecords(archive, 'agentRuns', agentRunRecordSchema),
      readJsonlRecords(archive, 'agentRunMessages', agentRunMessageRecordSchema),
      readJsonlRecords(archive, 'toolExecutions', toolExecutionRecordSchema),
      readJsonlRecords(archive, 'backgroundProcesses', backgroundProcessRecordSchema),
      readJsonlRecords(archive, 'attachmentImages', attachmentImageRecordSchema),
      readJsonlRecords(archive, 'attachmentPastedTexts', attachmentPastedTextRecordSchema),
      readJsonlRecords(archive, 'speechOutputs', speechOutputRecordSchema),
      readJsonlRecords(archive, 'speechSegments', speechSegmentRecordSchema),
      readJsonlRecords(archive, 'usageRecords', usageRecordSchema),
    ]);
    throwIfCancelled(signal);
    assertSessionOwnership(manifest.sessionId, {
      turns, messages, tasks, agentRuns, toolExecutions,
      backgroundProcesses, speechOutputs, speechSegments,
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

    // 2. 附件文件落位(先文件, 让 SQL 事务成为最后一步)
    const files = publishSessionFiles(
      activeDataDir,
      manifest.sessionId,
      archive,
      attachmentImages,
      attachmentPastedTexts,
      speechOutputs,
      speechSegments,
      backgroundProcesses,
      signal,
    );
    try {
      // 3. 单个事务写全部行。块内附件路径按 旧path→新path 重写;
      // uuid 全局唯一, 字符串替换无歧义;file_reference 的用户原路径不动。
      restorer.restoreSession({
        session: restoredSession,
        turns: turns.map(row => restoreTurnRecord(row, importedAt)),
        messages: messages.map(record => restoreMessageRecord({
          ...record,
          blocksJson: rewriteAttachmentPaths(record.blocksJson, files.attachments),
        })),
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

function rewriteAttachmentPaths(
  blocksJson: string,
  pathMap: ReadonlyMap<string, string>,
): string {
  let rewritten = blocksJson;
  for (const [oldPath, newPath] of pathMap) {
    if (oldPath === newPath) continue;
    // blocks_json 是 JSON 文本:Windows 反斜杠在里面以转义形态(\\)出现,
    // 直接按原始字符串替换会漏。统一按 JSON 转义形态重写(POSIX 下两形态相同)。
    const escapedOld = JSON.stringify(oldPath).slice(1, -1);
    const escapedNew = JSON.stringify(newPath).slice(1, -1);
    if (!rewritten.includes(escapedOld)) continue;
    rewritten = rewritten.split(escapedOld).join(escapedNew);
  }
  return rewritten;
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
