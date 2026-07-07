/**
 * tool-renderers — per-tool 参数/结果展示格式化注册表。
 *
 * 纯展示层，纯函数，可 mock。把"每个工具的字段语义"从 ToolCallBlock 的渲染逻辑里剥离：
 * ToolCallBlock 管容器/动画/高亮，这里管"fs_read 的 args 该显示哪些字段"。
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
    case 'fs_read':
    case 'fs_write':
    case 'fs_edit':
      return { rows: [row('path', a.path ?? a.file_path ?? a.filepath, true)] };

    case 'glob':
      return { rows: [row('pattern', a.pattern ?? a.glob, true)] };

    case 'grep':
      return {
        rows: [
          row('pattern', a.pattern ?? a.query, true),
          ...(a.path != null ? [row('path', a.path, true)] : []),
        ],
      };

    case 'bash':
    case 'powershell':
    case 'run_command':
    case 'shell':
      return { rows: [row('command', a.command ?? a.cmd, true)] };

    case 'web_search':
    case 'search':
      return { rows: [row('query', a.query)] };

    case 'web_fetch':
    case 'fetch':
    case 'url_fetch':
      return { rows: [row('url', a.url, true)] };

    case 'kb_search':
      return {
        rows: [
          row('query', a.query),
          ...(Array.isArray(a.kbIds) && a.kbIds.length > 0 ? [row('kb', (a.kbIds as string[]).join(', '))] : []),
        ],
      };

    case 'ask_user':
    case 'ask_text':
    case 'ask_choice':
    case 'ask_confirm':
      return { rows: [row('prompt', a.prompt ?? a.message ?? a.question)] };

    case 'todo_write':
      return { rows: [row('todos', `${Array.isArray(a.todos) ? a.todos.length : 0} items`)] };

    case 'artifact_write':
    case 'artifact_read':
    case 'artifact_list':
      return { rows: [row('artifact', a.artifactId ?? a.id)] };

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
