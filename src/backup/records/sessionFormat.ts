export const SESSION_MANIFEST_PATH = 'manifest.json';

export const SESSION_RECORD_PATHS = {
  session: 'records/session.json',
  turns: 'records/turns.jsonl',
  messages: 'records/messages.jsonl',
  tasks: 'records/tasks.jsonl',
  goals: 'records/goals.jsonl',
  subagents: 'records/subagents.jsonl',
  subagentRuns: 'records/subagentRuns.jsonl',
  subagentMessages: 'records/subagentMessages.jsonl',
  toolExecutions: 'records/toolExecutions.jsonl',
  backgroundProcesses: 'records/backgroundProcesses.jsonl',
  attachmentImages: 'records/attachmentImages.jsonl',
  attachmentPastedTexts: 'records/attachmentPastedTexts.jsonl',
  speechOutputs: 'records/speechOutputs.jsonl',
  usageRecords: 'records/usageRecords.jsonl',
} as const;

export type SessionRecordName = keyof typeof SESSION_RECORD_PATHS;

const recordPaths: ReadonlySet<string> = new Set(Object.values(SESSION_RECORD_PATHS));
const fileRoots: ReadonlySet<string> = new Set([
  'attachments',
  'speechOutputs',
  'backgroundProcesses',
]);

export function isSessionArchivePath(entryPath: string): boolean {
  if (entryPath === SESSION_MANIFEST_PATH || recordPaths.has(entryPath)) {
    return true;
  }
  const parts = entryPath.split('/');
  return parts.length >= 3
    && parts[0] === 'files'
    && fileRoots.has(parts[1]!);
}
