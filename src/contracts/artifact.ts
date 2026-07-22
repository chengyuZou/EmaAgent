import { ArtifactId, SessionId, TurnId } from './ids.js';

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
  | (string & {}); // 允许自定义类型，但必须是字符串

// ── 内容存储位置的区分联合 ─────────────────────────────────────

type ArtifactContentInline = {
  contentLocation: 'inline';
  content: string;          // 必填，存于 SQLite
  contentPath?: never;      // 禁止出现
};

type ArtifactContentFile = {
  contentLocation: 'file';
  content: null;            // 明确为 null，不是 undefined
  contentPath: string;      // 必填，磁盘绝对路径
};

// ── 应用/拒绝状态的互斥联合 ─────────────────────────────────────
type ArtifactStatus = 
  | { appliedAt: number; rejectedAt?: never }
  | { rejectedAt: number; appliedAt?: never }
  | { appliedAt?: never; rejectedAt?: never };  // 可简化为 {}

// ── 最终 Artifact 类型 ─────────────────────────────────────────

export interface ArtifactBase {
  id: ArtifactId;
  sessionId: SessionId;      // 必须明确所属会话
  turnId?: TurnId;           // 可选：属于哪个 turn
  type: ArtifactType;
  title: string;
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type Artifact = ArtifactBase
  & (ArtifactContentInline | ArtifactContentFile)
  & ({ appliedAt: number } | { rejectedAt: number } | Record<never, never>);
