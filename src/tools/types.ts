import { createHash } from 'node:crypto';

export function contentHashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export type ReadFileEntry =
  | ReadFileFullEntry
  | ReadFilePartialEntry;

/** 整读视图: 完整原文供 FileEdit 展示与防覆盖比对。 */
export interface ReadFileFullEntry {
  content: string;
  /** content 的 sha256 指纹,FileEdit/FileWrite 外部修改检测的比对基准。 */
  contentHash: string;
  /** 读取时的 mtime(毫秒)。 */
  timestamp: number;
  offset?: undefined;
  limit?: undefined;
  isPartialView: false;
  /** 整读内容同样可能按 50KB 正文预算截断, 回放必须保留这个事实。 */
  truncated: boolean;
}

/** 分页视图: 选中切片仅供去重回放; totalLines/truncated 为必备, 不允许非法组合。 */
export interface ReadFilePartialEntry {
  content: string;
  /** content(选中切片)的 sha256 指纹,与其他条目保持同一形状。 */
  contentHash: string;
  timestamp: number;
  offset?: number;
  limit?: number;
  isPartialView: true;
  /** 分页视图所在文件的总行数(回放给 Presentation 报总数)。 */
  totalLines: number;
  /** 读取时已按字节预算截断, 回放必须原样保留这个事实。 */
  truncated: boolean;
}

/** 以绝对规范化路径为键。 */
export type ReadFileState = Map<string, ReadFileEntry>;
