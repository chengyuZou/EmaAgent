// 定义 Tool 框架跨结果共享的非执行类型。

// ── ReadFileState - turn 内跨工具调用共享的去重缓存 ──────────────────────────

export type ReadFileEntry =
  | ReadFileFullEntry
  | ReadFilePartialEntry;

/** 整读视图: 完整原文供 FileEdit 防覆盖精确比对。 */
export interface ReadFileFullEntry {
  content: string;
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
