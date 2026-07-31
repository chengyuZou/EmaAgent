// 编排 Session 归档导入：先校验并重落文件，再把冻结后的记录交给 Storage 单事务恢复。
import fs from 'node:fs';
import path from 'node:path';
import type {
  AttachmentRestoreRow,
  AudioRestoreRow,
  BackgroundProcessRow,
  SessionBackupRestoreInput,
  SessionBackupRestorer,
} from '@ema-agent/storage';
import { SessionBackupRestoreError } from '@ema-agent/storage';
import { BACKUP_LIMITS, type BackupLimits } from '../limits.js';
import { BACKUP_MANIFEST_PATH } from '../records/recordRegistry.js';
import {
  restoreAgentRun,
  restoreAgentRunMessage,
  restoreBackgroundProcess,
  restoreKbActivation,
  restoreMessage,
  restoreTask,
  restoreTaskDependency,
  restoreToolExecution,
  restoreTurn,
  restoreUsage,
} from '../records/importMappings.js';
import {
  checkTaskDependencyGraph,
  validateAgentRunLinks,
  validateBackgroundProcessEnums,
  validateMessageEnums,
  validateSessionRecord,
  validateToolExecutionEnums,
  validateTurnEnums,
  validateUsageRecordScope,
  type RecordValidationIssue,
} from '../records/recordValidation.js';
import type {
  AgentRunMessageRecord,
  AgentRunRecord,
  AttachmentRecord,
  AudioRecord,
  BackgroundProcessRecord,
  KbActivationRecord,
  MemoryStateRecord,
  MessageRecord,
  SessionBackupManifest,
  SessionNotesRecord,
  SessionRecord,
  TaskDependencyRecord,
  TaskRecord,
  ToolExecutionRecord,
  TurnRecord,
  UsageRecord,
} from '../records/sessionRecords.js';
import { extractSessionArchive } from './archive.js';
import { SessionImportError } from './errors.js';
import { SessionImportFileCommit } from './file-commit.js';
import { verifyArchiveIntegrity } from './integrity.js';
import { assertPortableImportId } from './path-policy.js';
import {
  assertRequiredRecordFiles,
  readRecordJson,
  readRecordJsonl,
} from './recordReader.js';
import type { BackupArchiveSource } from '../types.js';

export interface ImportSessionOptions {
  readonly source: BackupArchiveSource;
  readonly activeDataDir: string;
  readonly restorer: Pick<SessionBackupRestorer, 'restore'>;
  readonly sessionExists: (sessionId: string) => boolean;
  /** 必需窄口:Provider 配置与模型同时存在才保留绑定。 */
  readonly modelPreferenceExists: (providerConfigId: string, modelId: string) => boolean;
  /** 必需窄口:KB 不存在则丢弃激活并产生警告,不让整个导入失败。 */
  readonly kbExists: (kbId: string) => boolean;
  readonly signal?: AbortSignal;
  readonly limits?: BackupLimits;
}

export interface ImportedSession {
  readonly sessionId: string;
  readonly warnings: readonly string[];
}

export async function importSession(
  options: ImportSessionOptions,
): Promise<ImportedSession> {
  const limits = options.limits ?? BACKUP_LIMITS;
  const archive = await extractSessionArchive(
    options.source,
    path.join(options.activeDataDir, '.imports'),
    options.signal,
    limits,
  );
  let files: SessionImportFileCommit | null = null;
  try {
    await verifyArchiveIntegrity(archive, options.signal);
    assertRequiredRecordFiles(archive);
    const manifest = readArchiveJson<SessionBackupManifest>(archive, BACKUP_MANIFEST_PATH);
    assertManifest(manifest);
    const session = requireJson<SessionRecord>(archive, 'session');
    const importedAt = Date.now();
    assertPortableImportId(session.id, 'Session id');
    assertIssues(validateSessionRecord(session));
    if (manifest.sessionId !== session.id) {
      throw new SessionImportError('invalid_format', 'manifest 与 Session 记录身份不一致');
    }
    if (options.sessionExists(session.id)) {
      throw new SessionImportError('destination_conflict', `会话 ${session.id} 已存在`, 409);
    }

    files = new SessionImportFileCommit(options.activeDataDir, session.id);
    const omitted = new Set(manifest.warnings.map(item => `${item.kind}:${item.id}`));
    const warnings = manifest.warnings.map(
      item => `${item.kind} ${item.id} 在导出时已省略: ${item.reason}`,
    );
    const total = { count: 1 };
    const taskDependencies = collect<TaskDependencyRecord>(
      records(archive, 'taskDependencies', total, limits),
    );
    const agentRuns = collect<AgentRunRecord>(
      records(archive, 'agentRuns', total, limits),
    );
    assertIssues(checkTaskDependencyGraph(taskDependencies));
    assertIssues(validateAgentRunLinks(agentRuns));

    const attachments = restoreAttachments(
      collect<AttachmentRecord>(records(archive, 'attachments', total, limits)),
      archive,
      files,
      omitted,
      warnings,
    );
    const audio = restoreAudio(
      collect<AudioRecord>(records(archive, 'audio', total, limits)),
      archive,
      files,
      omitted,
      warnings,
    );
    const backgroundProcesses = restoreBackgroundProcesses(
      collect<BackgroundProcessRecord>(
        records(archive, 'backgroundProcesses', total, limits),
      ),
      archive,
      files,
      session.id,
      omitted,
      warnings,
      importedAt,
    );

    const preferred = session.preferredProviderConfigId !== null
      && session.preferredModelId !== null
      && options.modelPreferenceExists(
        session.preferredProviderConfigId,
        session.preferredModelId,
      )
      ? {
          providerConfigId: session.preferredProviderConfigId,
          modelId: session.preferredModelId,
        }
      : null;
    if (session.preferredProviderConfigId !== null && preferred === null) {
      warnings.push('来源模型偏好在当前设备不可用，已清空');
    }

    const input: SessionBackupRestoreInput = {
      session: {
        id: session.id, title: session.title, createdAt: session.createdAt,
        updatedAt: session.updatedAt, lastActivityAt: session.lastActivityAt,
        archivedAt: session.archivedAt, pinned: session.pinned, pinnedAt: session.pinnedAt,
        groupLabel: session.groupLabel, parentSessionId: session.parentSessionId,
        executionProfile: session.executionProfile, narrativePolicy: session.narrativePolicy,
        preferredProviderConfigId: preferred?.providerConfigId ?? null,
        preferredModelId: preferred?.modelId ?? null,
      },
      turns: mapValidated<TurnRecord, ReturnType<typeof restoreTurn>>(
        records(archive, 'turns', total, limits),
        validateTurnEnums,
        record => restoreTurn(record, importedAt),
      ),
      messages: mapValidated<MessageRecord, ReturnType<typeof restoreMessage>>(
        records(archive, 'messages', total, limits),
        validateMessageEnums,
        restoreMessage,
      ),
      tasks: mapRecords<TaskRecord, ReturnType<typeof restoreTask>>(
        records(archive, 'tasks', total, limits),
        restoreTask,
      ),
      taskDependencies: taskDependencies.map(restoreTaskDependency),
      agentRuns: agentRuns.map(record => restoreAgentRun(record, importedAt)),
      agentRunMessages: mapRecords<AgentRunMessageRecord, ReturnType<typeof restoreAgentRunMessage>>(
        records(archive, 'agentRunMessages', total, limits),
        restoreAgentRunMessage,
      ),
      toolExecutions: mapValidated<ToolExecutionRecord, ReturnType<typeof restoreToolExecution>>(
        records(archive, 'toolExecutions', total, limits),
        validateToolExecutionEnums,
        record => restoreToolExecution(record, importedAt),
      ),
      backgroundProcesses,
      attachments,
      audio,
      usageRecords: mapValidated<UsageRecord, ReturnType<typeof restoreUsage>>(
        records(archive, 'usageRecords', total, limits),
        validateUsageRecordScope,
        restoreUsage,
      ),
      kbActivations: mapRecords<KbActivationRecord, ReturnType<typeof restoreKbActivation>>(
        records(archive, 'kbActivations', total, limits),
        record => {
          if (!options.kbExists(record.kbId)) {
            warnings.push(`KB ${record.kbId} 在当前设备不存在，已跳过激活记录 ${record.id}`);
            return null;
          }
          return restoreKbActivation(record);
        },
        true,
      ),
      memoryState: mapMemoryState(optionalJson<MemoryStateRecord>(archive, 'memoryState')),
      notes: optionalJson<SessionNotesRecord>(archive, 'sessionNotes'),
    };
    options.restorer.restore(input);
    files.commit();
    return { sessionId: session.id, warnings };
  } catch (error) {
    files?.rollback();
    if (error instanceof SessionImportError) throw error;
    if (error instanceof SessionBackupRestoreError) {
      throw new SessionImportError('restore_failed', error.message, 500);
    }
    throw new SessionImportError(
      'invalid_format',
      error instanceof Error ? error.message : 'Session 备份导入失败',
    );
  } finally {
    archive.dispose();
  }
}

function records(
  archive: Parameters<typeof readRecordJsonl>[0],
  name: Parameters<typeof readRecordJsonl>[1],
  total: { count: number },
  limits: BackupLimits,
): Iterable<unknown> {
  const source = readRecordJsonl(archive, name, limits);
  return {
    *[Symbol.iterator]() {
      for (const record of source) {
        total.count += 1;
        if (total.count > limits.maxTotalRecords) {
          throw new SessionImportError('entry_too_large', '备份总记录数超过限制', 413);
        }
        assertPlainRecord(record, name);
        yield record;
      }
    },
  };
}

function mapValidated<T, U>(
  source: Iterable<unknown>,
  validate: (record: T) => RecordValidationIssue[],
  map: (record: T) => U,
): Iterable<U> {
  return mapRecords<T, U>(source, (record) => {
    assertIssues(validate(record));
    return map(record);
  });
}

function mapRecords<T, U>(
  source: Iterable<unknown>,
  map: (record: T) => U | null,
  skipNull = false,
): Iterable<U> {
  return {
    *[Symbol.iterator]() {
      for (const value of source) {
        const mapped = map(value as T);
        if (mapped === null && skipNull) continue;
        yield mapped as U;
      }
    },
  };
}

function collect<T>(source: Iterable<unknown>): T[] {
  return [...source] as T[];
}

function requireJson<T>(
  archive: Parameters<typeof readRecordJson>[0],
  name: Parameters<typeof readRecordJson>[1],
): T {
  const value = readRecordJson<T>(archive, name);
  if (value === null) throw new SessionImportError('invalid_format', `备份缺少 ${name}`);
  assertPlainRecord(value, name);
  return value;
}

function optionalJson<T>(
  archive: Parameters<typeof readRecordJson>[0],
  name: Parameters<typeof readRecordJson>[1],
): T | null {
  const value = readRecordJson<T>(archive, name);
  if (value !== null) assertPlainRecord(value, name);
  return value;
}

function assertManifest(manifest: SessionBackupManifest): void {
  if (manifest.format !== 'ema-session' || manifest.version !== 2) {
    throw new SessionImportError(
      'unsupported_version',
      `不支持备份版本 ${String(manifest.version)}`,
    );
  }
  if (!Array.isArray(manifest.warnings)) {
    throw new SessionImportError('invalid_format', 'manifest.warnings 必须是数组');
  }
}

function assertPlainRecord(value: unknown, scope: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionImportError('invalid_format', `${scope} 记录必须是对象`);
  }
}

function assertIssues(issues: readonly RecordValidationIssue[]): void {
  if (issues.length > 0) {
    throw new SessionImportError(
      'invalid_format',
      `${issues[0]!.scope}: ${issues[0]!.message}`,
    );
  }
}

function restoreAttachments(
  records: readonly AttachmentRecord[],
  archive: Parameters<typeof readRecordJson>[0],
  files: SessionImportFileCommit,
  omitted: ReadonlySet<string>,
  warnings: string[],
): AttachmentRestoreRow[] {
  const output: AttachmentRestoreRow[] = [];
  for (const record of records) {
    assertPortableImportId(record.id, 'Attachment id');
    assertPortableImportId(record.turnId, 'Attachment turnId');
    assertResourcePath(record.filePath, 'attachments', record.id);
    const entry = archive.get(record.filePath);
    if (!entry || omitted.has(`attachment:${record.id}`)) {
      warnings.push(`附件 ${record.id} 没有可恢复文件，已跳过`);
      continue;
    }
    const destination = files.copyAttachment(entry.filePath, record.id, safeFileName(record.name));
    const size = fs.statSync(destination).size;
    if (size !== record.size || size > BACKUP_LIMITS.maxAttachmentBytes) {
      throw new SessionImportError('invalid_format', `附件大小不匹配或超过限制: ${record.id}`);
    }
    output.push({
      id: record.id, turnId: record.turnId, name: record.name, mime: record.mime,
      size, mtime: record.mtime, localPath: destination, createdAt: record.createdAt,
    });
  }
  return output;
}

function restoreAudio(
  records: readonly AudioRecord[],
  archive: Parameters<typeof readRecordJson>[0],
  files: SessionImportFileCommit,
  omitted: ReadonlySet<string>,
  warnings: string[],
): AudioRestoreRow[] {
  const output: AudioRestoreRow[] = [];
  for (const record of records) {
    assertPortableImportId(record.turnId, 'Audio turnId');
    assertResourcePath(record.filePath, 'audio', record.turnId);
    const entry = archive.get(record.filePath);
    if (!entry || omitted.has(`audio:${record.turnId}`)) {
      warnings.push(`音频 ${record.turnId} 没有可恢复文件，已跳过`);
      continue;
    }
    const suffix = path.extname(record.filePath) || '.bin';
    const destination = files.copyToSession(entry.filePath, 'audio', 'merged', `${record.turnId}${suffix}`);
    const size = fs.statSync(destination).size;
    if (size !== record.byteSize || size > BACKUP_LIMITS.maxAudioBytes) {
      throw new SessionImportError('invalid_format', `音频大小不匹配或超过限制: ${record.turnId}`);
    }
    output.push({
      turnId: record.turnId, sessionId: record.sessionId, storagePath: destination,
      mimeType: record.mimeType, byteSize: size, durationMs: record.durationMs,
      segmentCount: record.segmentCount, createdAt: record.createdAt,
    });
  }
  return output;
}

function restoreBackgroundProcesses(
  records: readonly BackgroundProcessRecord[],
  archive: Parameters<typeof readRecordJson>[0],
  files: SessionImportFileCommit,
  sessionId: string,
  omitted: ReadonlySet<string>,
  warnings: string[],
  importedAt: number,
): BackgroundProcessRow[] {
  return records.map((record) => {
    assertPortableImportId(record.id, 'BackgroundProcess id');
    assertIssues(validateBackgroundProcessEnums(record));
    const expectedRoot = `files/backgroundProcesses/${record.id}/`;
    if (record.outputDirectoryPath !== expectedRoot) {
      throw new SessionImportError('invalid_format', `后台输出路径与进程身份不一致: ${record.id}`);
    }
    const relative = path.join('sessions', sessionId, 'background-processes', record.id);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    if (!omitted.has(`backgroundProcessOutput:${record.id}`)) {
      for (const name of ['stdout.log', 'stderr.log']) {
        const entry = archive.get(`${record.outputDirectoryPath}${name}`);
        if (!entry) {
          warnings.push(`后台进程 ${record.id} 缺少 ${name}，已按空日志恢复`);
          continue;
        }
        if (entry.size > BACKUP_LIMITS.maxBackgroundOutputBytes) {
          throw new SessionImportError('entry_too_large', `后台输出超过限制: ${record.id}/${name}`, 413);
        }
        files.copyToSession(entry.filePath, 'background-processes', record.id, name);
        if (name === 'stdout.log') stdoutBytes = entry.size;
        else stderrBytes = entry.size;
      }
    } else {
      warnings.push(`后台进程 ${record.id} 的输出日志在导出时已省略`);
    }
    return restoreBackgroundProcess({
      ...record,
      stdoutBytes,
      stderrBytes,
      outputTruncated: record.outputTruncated
        || stdoutBytes !== record.stdoutBytes
        || stderrBytes !== record.stderrBytes,
    }, relative, importedAt);
  });
}

function readArchiveJson<T>(
  archive: Parameters<typeof readRecordJson>[0],
  entryPath: string,
): T {
  const entry = archive.require(entryPath);
  if (entry.size > BACKUP_LIMITS.jsonlMaxLineBytes) {
    throw new SessionImportError('entry_too_large', `${entryPath} 超过 JSON 大小限制`, 413);
  }
  try {
    const value = JSON.parse(fs.readFileSync(entry.filePath, 'utf8')) as T;
    assertPlainRecord(value, entryPath);
    return value;
  } catch (error) {
    if (error instanceof SessionImportError) throw error;
    throw new SessionImportError('invalid_format', `${entryPath} 不是合法 JSON`);
  }
}

function mapMemoryState(record: MemoryStateRecord | null): {
  session_id: string;
  surfaced_json: string;
  overrides_json: string;
} | null {
  return record ? {
    session_id: record.sessionId,
    surfaced_json: record.surfacedJson,
    overrides_json: record.overridesJson,
  } : null;
}

function safeFileName(value: string): string {
  const name = path.basename(value).replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80);
  if (!name) throw new SessionImportError('invalid_format', '附件名称无效');
  return name;
}

function assertResourcePath(
  archivePath: string,
  root: 'attachments' | 'audio',
  id: string,
): void {
  const prefix = `files/${root}/${id}/`;
  if (!archivePath.startsWith(prefix) || archivePath.length === prefix.length) {
    throw new SessionImportError(
      'invalid_format',
      `${root} 文件路径与记录身份不一致: ${id}`,
    );
  }
}
