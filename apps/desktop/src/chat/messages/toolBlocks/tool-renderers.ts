// 通用回退渲染：未注册专属 UI 的工具（MCP/未知）把参数平铺为 key-value 行、
// 结果按形状分派为文本/平铺/JSON。不识别任何具体工具的字段语义。
// 纯展示层，纯函数，可 mock。

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

/** MCP/未知工具的兜底：平铺所有顶层字段，不理解字段含义。 */
export function renderToolArgs(args: unknown): ToolArgView {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
  const row = (key: string, value: unknown, mono = false): ToolArgRow => ({ key, value: str(value), mono });

  return {
    rows: Object.entries(a)
      .filter(([, v]) => v != null)
      .map(([k, v]) => row(k, v, typeof v !== 'string')),
  };
}

// ── 结果视图 ──────────────────────────────────────────────────────────────────

export type ToolResultView =
  | { kind: 'text'; text: string; lang?: 'plain' | 'json' }
  | { kind: 'rows'; rows: ToolArgRow[] }
  | { kind: 'raw';  text: string; lang: 'json' };

/**
 * 按结果类型分派展示：字符串 → text；扁平对象 → rows 平铺；深嵌套/数组 → raw（调用方剥外层 {}）。
 */
export function renderToolResult(result: unknown): ToolResultView {
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
