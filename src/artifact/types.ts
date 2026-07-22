import type { SessionId, TurnId } from '@ema-agent/ids';

declare const artifactIdBrand: unique symbol;
export type ArtifactId = string & { readonly [artifactIdBrand]: 'ArtifactId' };

export function asArtifactId(value: string): ArtifactId {
  return value as ArtifactId;
}

export type ArtifactType =
  | 'text/markdown'
  | 'text/html'
  | 'text/plain'
  | 'text/csv'
  | 'text/x-python'
  | 'text/x-typescript'
  | 'text/x-javascript'
  | 'text/x-rust'
  | 'text/x-go'
  | 'application/json'
  | 'application/vnd.ema.diff'
  | 'application/vnd.ema.table'
  | 'application/vnd.ema.chart'
  | (string & {});

type ArtifactContent =
  | { contentLocation: 'inline'; content: string; contentPath?: never }
  | { contentLocation: 'file'; content: null; contentPath: string };

type ArtifactStatus =
  | { appliedAt: number; rejectedAt?: never }
  | { rejectedAt: number; appliedAt?: never }
  | { appliedAt?: never; rejectedAt?: never };

export interface ArtifactBase {
  id: ArtifactId;
  sessionId: SessionId;
  turnId?: TurnId;
  type: ArtifactType;
  title: string;
  /** Artifact 是开放产物格式，只有这里允许扩展元数据。 */
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type Artifact = ArtifactBase & ArtifactContent & ArtifactStatus;

export interface ArtifactUpsertArgs {
  id?: ArtifactId;
  sessionId: SessionId;
  turnId?: TurnId;
  type: ArtifactType;
  title: string;
  content: string;
  meta?: Record<string, unknown>;
}

export interface ArtifactPersistence {
  insert(artifact: Artifact): void;
  update(id: ArtifactId, patch: ArtifactUpdate): void;
  findById(id: ArtifactId): Artifact | null;
  listBySession(sessionId: SessionId, opts?: { type?: string; includeContent?: boolean }): Omit<Artifact, 'content'>[];
  listForExport(sessionId: SessionId): Artifact[];
  deleteById(id: ArtifactId): void;
  countBySession(sessionId: SessionId): number;
}

export interface ArtifactOwnership {
  assertTurnOwnership(sessionId: SessionId, turnId: TurnId): void;
}

export interface ArtifactUpdate {
  content?: string | null;
  contentLocation?: 'inline' | 'file';
  contentPath?: string;
  title?: string;
  type?: ArtifactType;
  meta?: Record<string, unknown>;
  appliedAt?: number;
  rejectedAt?: number;
  updatedAt?: number;
}

export interface IArtifactStore {
  upsert(args: ArtifactUpsertArgs): Artifact;
  get(id: ArtifactId): Artifact | null;
  list(sessionId: SessionId, opts?: { type?: string }): Omit<Artifact, 'content'>[];
  apply(id: ArtifactId, targetPath: string): Artifact;
  reject(id: ArtifactId): Artifact;
  delete(id: ArtifactId): void;
  countWarning(sessionId: SessionId): boolean;
}
