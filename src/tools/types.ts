// 定义 Tool 框架跨结果、能力与 Manifest 使用的非执行类型。
import type { ToolManifestEntry } from './Tool/tool.js';

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

/** 一项只能收窄、不能扩大当前 Agent 工具能力的限制。 */
export interface ToolCapabilityRestriction {
  /** 便于审计和报错的来源，例如 skill:pdf。 */
  source: string;
  /** 对模型可见工具名或稳定内部 ID 进行匹配。 */
  allowedToolPatterns: readonly string[];
}

/** 应用限制后可供模型和执行器共同使用的只读快照。 */
export interface ToolCapabilitySnapshot {
  allowedToolNames: readonly string[];
  restrictionSources: readonly string[];
}

/** Agent 注入工具上下文的能力边界；Skill、运行模式等只能调用 restrict。 */
export interface ToolCapabilityScope {
  restrict(restriction: ToolCapabilityRestriction): ToolCapabilitySnapshot;
  snapshot(): ToolCapabilitySnapshot;
}

/**
 * ToolRegistry 为一次 Agent 执行生成的不可变能力快照。
 *
 * entries 是最终发送给模型的规范顺序：Builtin 是连续前缀，MCP 是连续后缀。
 * registryVersion 只标识注册表运行时世代；revision 只由模型可见内容决定。
 */
export interface ToolManifestSnapshot {
  readonly registryVersion: number;
  readonly revision: string;
  readonly entries: readonly ToolManifestEntry[];
}

declare const executableToolManifestBrand: unique symbol;

/**
 * 由 ToolRegistry 冻结并保留实现绑定的 Manifest。
 *
 * Context 与 Provider 只需要 ToolManifestSnapshot；执行主链必须持有本类型，
 * 防止把仅含模型投影的派生清单误当成可执行能力。
 */
export interface ExecutableToolManifestSnapshot extends ToolManifestSnapshot {
  readonly [executableToolManifestBrand]: true;
}
