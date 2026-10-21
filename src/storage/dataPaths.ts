import path from 'node:path';

// These are Session-owned files. Profile assets and backup staging are not swept with them.
export const SESSION_RESOURCE_KINDS = [
  'attachments',
  'audio',
  'web-fetch',
  'tool-results',
  'background-processes',
  'scratchpad',
] as const;

export type SessionResourceKind = typeof SESSION_RESOURCE_KINDS[number];

export function dataResourceDir(dataDir: string, kind: SessionResourceKind): string {
  return path.join(dataDir, kind);
}

export function sessionResourceDir(
  dataDir: string,
  kind: SessionResourceKind,
  sessionId: string,
): string {
  return path.join(dataResourceDir(dataDir, kind), sessionId);
}

export function turnResourceDir(
  dataDir: string,
  kind: 'audio' | 'scratchpad',
  sessionId: string,
  turnId: string,
): string {
  return path.join(sessionResourceDir(dataDir, kind, sessionId), turnId);
}
