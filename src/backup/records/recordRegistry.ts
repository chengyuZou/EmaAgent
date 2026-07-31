// 备份 records/ 条目的唯一注册表:导出、导入、路径白名单与完整性检查共用同一份定义。

export type BackupRecordName =
  | 'session'
  | 'turns'
  | 'messages'
  | 'tasks'
  | 'taskDependencies'
  | 'agentRuns'
  | 'agentRunMessages'
  | 'toolExecutions'
  | 'backgroundProcesses'
  | 'attachments'
  | 'audio'
  | 'usageRecords'
  | 'kbActivations'
  | 'memoryState'
  | 'sessionNotes';

export interface BackupRecordDefinition {
  readonly name: BackupRecordName;
  /** ZIP 内的规范路径(records/ 下)。 */
  readonly archivePath: string;
  /** 单对象 json / 集合 jsonl,语义即单复数。 */
  readonly encoding: 'json' | 'jsonl';
  /** required=true 缺失即拒绝;false 缺失按空集合/空对象处理。 */
  readonly required: boolean;
  /** jsonl 行数上限(json 恒为 1),防单文件记录炸弹。 */
  readonly maxRecords: number;
}

const RECORDS_ROOT = 'records';

function jsonl(
  name: BackupRecordName,
  fileBase: string,
  maxRecords: number,
): BackupRecordDefinition {
  return {
    name,
    archivePath: `${RECORDS_ROOT}/${fileBase}.jsonl`,
    encoding: 'jsonl',
    // 规范导出器即使空集合也写空文件;缺失即残缺归档,不用"缺失等于空集合"掩盖。
    required: true,
    maxRecords,
  };
}

function json(
  name: BackupRecordName,
  fileBase: string,
  required: boolean,
): BackupRecordDefinition {
  return {
    name,
    archivePath: `${RECORDS_ROOT}/${fileBase}.json`,
    encoding: 'json',
    required,
    maxRecords: 1,
  };
}

/** 注册表即格式契约;新增记录类型必须在这里登记,否则白名单直接拒绝。 */
export const BACKUP_RECORD_REGISTRY: readonly BackupRecordDefinition[] = Object.freeze([
  json('session', 'session', true),
  jsonl('turns', 'turns', 100_000),
  jsonl('messages', 'messages', 1_000_000),
  jsonl('tasks', 'tasks', 100_000),
  jsonl('taskDependencies', 'taskDependencies', 200_000),
  jsonl('agentRuns', 'agentRuns', 100_000),
  jsonl('agentRunMessages', 'agentRunMessages', 1_000_000),
  jsonl('toolExecutions', 'toolExecutions', 1_000_000),
  jsonl('backgroundProcesses', 'backgroundProcesses', 10_000),
  jsonl('attachments', 'attachments', 100_000),
  jsonl('audio', 'audio', 100_000),
  jsonl('usageRecords', 'usageRecords', 1_000_000),
  jsonl('kbActivations', 'kbActivations', 1_000_000),
  json('memoryState', 'memoryState', false),
  json('sessionNotes', 'sessionNotes', false),
]);

export function recordDefinition(name: BackupRecordName): BackupRecordDefinition {
  const found = BACKUP_RECORD_REGISTRY.find((def) => def.name === name);
  if (!found) throw new Error(`backup record not registered: ${name}`);
  return found;
}

/** manifest 与完整性清单的固定路径。 */
export const BACKUP_MANIFEST_PATH = 'manifest.json';
export const BACKUP_INTEGRITY_PATH = 'integrity/sha256.json';

/** records/ 全部合法条目路径,供解压白名单精确匹配。 */
export const BACKUP_RECORD_PATHS: ReadonlySet<string> = new Set(
  BACKUP_RECORD_REGISTRY.map((def) => def.archivePath),
);

/** files/ 下的合法二级根;条目形态为 files/<root>/<id>/... 两级以上。 */
export const BACKUP_FILE_ROOTS: ReadonlySet<string> = new Set([
  'attachments',
  'audio',
  'backgroundProcesses',
]);
