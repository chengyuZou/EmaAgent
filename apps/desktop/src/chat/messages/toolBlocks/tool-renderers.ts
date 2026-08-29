// 这里把各类工具的参数和结果转换成前端可以直接展示的行或文本。
import { BuiltinTools } from '@ema-agent/tools';

/**
 * tool-renderers — per-tool 参数/结果展示格式化注册表。
 *
 * 纯展示层，纯函数，可 mock。把"每个工具的字段语义"从 ToolCallBlock 的渲染逻辑里剥离：
 * ToolCallBlock 管容器/动画/高亮，这里管“Read 的参数该显示哪些字段”。
 *
 * 核心目标：去掉 JSON.stringify 的 `{}` 包裹，参数/结果改成 key-value 平铺。
 * 新增工具展示 → 往 switch 加一个 case，不碰 ToolCallBlock。
 */

// ── 参数视图 ──────────────────────────────────────────────────────────────────

export interface ToolArgRow {
  key:   string;
  value: string;
  /** 等宽显示（路径/命令/pattern 等） */
  mono?: boolean;
}

export interface ToolArgView {
  rows: ToolArgRow[];
}

/**
 * 按工具名把 args 格式化成平铺行。已知工具只显示语义字段；
 * 未知工具（含 mcp__<server>__<tool>）平铺所有顶层字段作兜底。
 */
export function renderToolArgs(name: string, args: unknown): ToolArgView {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
  const row = (key: string, value: unknown, mono = false): ToolArgRow => ({ key, value: str(value), mono });

  switch (name) {
    case BuiltinTools.FileRead.name:
    case BuiltinTools.FileWrite.name:
    case BuiltinTools.FileEdit.name:
      return { rows: [row('path', a.file_path, true)] };

    case BuiltinTools.Glob.name:
      return { rows: [row('pattern', a.pattern, true)] };

    case BuiltinTools.Grep.name:
      return {
        rows: [
          row('pattern', a.pattern, true),
          ...(a.path != null ? [row('path', a.path, true)] : []),
        ],
      };

    case BuiltinTools.Bash.name:
    case BuiltinTools.PowerShell.name:
      return { rows: [row('command', a.command, true)] };

    case BuiltinTools.WebSearch.name:
      return { rows: [row('query', a.query)] };

    case BuiltinTools.WebFetch.name:
      return { rows: [row('url', a.url, true)] };

    case BuiltinTools.KnowledgeBaseSearch.name:
      return { rows: [row('query', a.query)] };

    case BuiltinTools.AskUser.name:
      return { rows: [row('questions', a.questions)] };

    default:
      // mcp__<server>__<tool> / 未知工具 → 平铺顶层字段
      return {
        rows: Object.entries(a)
          .filter(([, v]) => v != null)
          .map(([k, v]) => row(k, v, typeof v !== 'string')),
      };
  }
}

// ── 结果视图 ──────────────────────────────────────────────────────────────────

export type ToolResultView =
  | { kind: 'text'; text: string; lang?: 'plain' | 'json' }
  | { kind: 'rows'; rows: ToolArgRow[] }
  | { kind: 'raw';  text: string; lang: 'json' };

/**
 * 按结果类型分派展示：字符串 → text；扁平对象 → rows 平铺；深嵌套/数组 → raw（调用方剥外层 {}）。
 */
export function renderToolResult(_name: string, result: unknown): ToolResultView {
  if (result == null) return { kind: 'text', text: '' };

  if (typeof result === 'string') {
    const trimmed = result.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // 字符串里裹着 JSON — 尝试解析后走对象/数组分支，失败则原样
      try {
        return renderObjectResult(JSON.parse(result));
      } catch {
        return { kind: 'text', text: result };
      }
    }
    return { kind: 'text', text: result };
  }

  return renderObjectResult(result);
}

function renderObjectResult(result: unknown): ToolResultView {
  if (Array.isArray(result)) {
    return { kind: 'raw', text: JSON.stringify(result, null, 2), lang: 'json' };
  }
  if (typeof result === 'object' && result !== null) {
    const entries = Object.entries(result as Record<string, unknown>);
    // 扁平对象（值全是基本类型）→ 平铺 rows
    const flat = entries.every(([, v]) => v == null || typeof v !== 'object');
    if (flat && entries.length > 0) {
      const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
      return {
        kind: 'rows',
        rows: entries
          .filter(([, v]) => v != null)
          .map(([k, v]) => ({ key: k, value: str(v), mono: typeof v !== 'string' })),
      };
    }
    return { kind: 'raw', text: JSON.stringify(result, null, 2), lang: 'json' };
  }
  return { kind: 'text', text: String(result) };
}

/** 剥掉 JSON 最外层花括号/方括号，给 raw 视图用（保留内部高亮）。 */
export function stripOuterBraces(code: string): string {
  return code
    .replace(/^\{\n?/, '')
    .replace(/\n?\}$/, '')
    .replace(/^\[\n?/, '')
    .replace(/\n?\]$/, '');
}
