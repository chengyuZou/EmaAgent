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

export interface Artifact {
  id:              ArtifactId;
  sessionId:       SessionId;       // 补上
  turnId?:         TurnId;          // 补上
  type:            ArtifactType;
  title:           string;
  content:         string | null;   // null when contentLocation='file'
  /**
   * - contentLocation: `inline` → 内容就存在 SQLite 的 content 列里，content 有值，contentPath 是 undefined
   * - contentLocation: `file` → 内容写到磁盘文件，content 是 null，contentPath 是文件绝对路径
   * 
   * 为什么要分两种：SQLite 存大文本（几百KB的代码、CSV、JSON）会让整个 DB 文件膨胀，查询也变慢。内容超 64KB 时写文件更合理。
   * 前端调 GET /api/artifacts/:id 时，后端透明地把文件内容读回来填进 content，前端永远看到非 null 的 content，不感知这个分支。
   */
  contentLocation: 'inline' | 'file';
  contentPath?:    string;
  /**
   * 如果是代码的话可以提供一些原数据
   * 比如: `{ language: 'python' }` 给 Monaco 设语言模式。未知 type 降级到 Monaco 纯文本，不崩溃。
   */
  meta:            Record<string, unknown>;
  createdAt:       number;
  updatedAt:       number;
  appliedAt?:      number;
  rejectedAt?:     number;
}