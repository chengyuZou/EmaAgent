// 固定 Session ZIP 的记录路径与文件资源目录，导入和导出共同使用。

export type SessionRecordName =
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
  | 'speechOutputs'
  | 'speechSegments'
  | 'usageRecords';

export interface SessionRecordFile {
  readonly name: SessionRecordName;
  readonly path: string;
  readonly encoding: 'json' | 'jsonl';
}

function json(name: SessionRecordName): SessionRecordFile {
  return { name, path: `records/${name}.json`, encoding: 'json' };
}

function jsonl(name: SessionRecordName): SessionRecordFile {
  return { name, path: `records/${name}.jsonl`, encoding: 'jsonl' };
}

export const SESSION_MANIFEST_PATH = 'manifest.json';

export const SESSION_RECORD_FILES: readonly SessionRecordFile[] = Object.freeze([
  json('session'),
  jsonl('turns'),
  jsonl('messages'),
  jsonl('tasks'),
  jsonl('taskDependencies'),
  jsonl('agentRuns'),
  jsonl('agentRunMessages'),
  jsonl('toolExecutions'),
  jsonl('backgroundProcesses'),
  jsonl('attachments'),
  jsonl('speechOutputs'),
  jsonl('speechSegments'),
  jsonl('usageRecords'),
]);

export const SESSION_RECORD_PATHS: ReadonlySet<string> = new Set(
  SESSION_RECORD_FILES.map(file => file.path),
);

export const SESSION_FILE_ROOTS: ReadonlySet<string> = new Set([
  'attachments',
  'speechOutputs',
  'speechSegments',
  'backgroundProcesses',
]);

export function sessionRecordFile(name: SessionRecordName): SessionRecordFile {
  const file = SESSION_RECORD_FILES.find(candidate => candidate.name === name);
  if (!file) throw new Error(`未登记的 Session 记录: ${name}`);
  return file;
}

export function isSessionArchivePath(entryPath: string): boolean {
  if (entryPath === SESSION_MANIFEST_PATH || SESSION_RECORD_PATHS.has(entryPath)) return true;
  const parts = entryPath.split('/');
  return parts.length >= 3
    && parts[0] === 'files'
    && SESSION_FILE_ROOTS.has(parts[1]!);
}
