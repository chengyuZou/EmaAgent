// 未注册专属 UI 的工具只按结果形状选择 Markdown、字段表或 JSON, 不猜具体工具的字段语义.

// ── 参数视图 ──────────────────────────────────────────────────────────────────

export interface ToolArgRow {
  key: string;
  value: string;
  /** 对象、数组、数字和布尔值按代码值显示, 普通说明文字继续使用内容字体. */
  mono?: boolean;
}

export interface ToolArgView {
  rows: ToolArgRow[];
}

/** MCP/未知工具的兜底: 平铺所有顶层字段, 不理解字段含义. */
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
  | { kind: 'markdown'; source: string }
  | { kind: 'rows'; rows: ToolArgRow[] }
  | { kind: 'code'; source: string; language: 'json' };

/**
 * 字符串可能来自 MCP 的 Markdown 结果, 完整交给公共 Markdown renderer.
 * 扁平对象适合快速扫字段; 数组和嵌套对象保留完整 JSON 结构并用公共 hljs 主题显示.
 */
export function renderToolResult(result: unknown): ToolResultView {
  if (result == null) return { kind: 'markdown', source: '' };

  if (typeof result === 'string') {
    const trimmed = result.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // 字符串里包着 JSON 时按真实结构显示; 解析失败仍按原始 Markdown 显示.
      try {
        return renderObjectResult(JSON.parse(result));
      } catch {
        return { kind: 'markdown', source: result };
      }
    }
    return { kind: 'markdown', source: result };
  }

  return renderObjectResult(result);
}

function renderObjectResult(result: unknown): ToolResultView {
  if (Array.isArray(result)) {
    return { kind: 'code', source: JSON.stringify(result, null, 2), language: 'json' };
  }
  if (typeof result === 'object' && result !== null) {
    const entries = Object.entries(result as Record<string, unknown>);
    // 扁平对象直接平铺, 避免两三个状态字段占用一整块代码区域.
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
    return { kind: 'code', source: JSON.stringify(result, null, 2), language: 'json' };
  }
  return { kind: 'markdown', source: String(result) };
}
