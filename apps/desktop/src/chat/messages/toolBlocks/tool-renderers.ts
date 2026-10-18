export interface ToolArgRow {
  key: string;
  value: string;
  /** 对象, 数组, 数字和布尔值按代码值显示, 普通说明文字继续使用内容字体. */
  mono?: boolean;
}

/** 结构化错误仅改变展示; 工具返回给模型的原文与复制内容不变. */
export function renderToolError(message: string): ToolArgRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const rows: ToolArgRow[] = [];
  const visit = (key: string, value: unknown): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(`${key}.${childKey}`, childValue);
      }
      return;
    }
    rows.push({
      key,
      value: value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value),
      ...(typeof value !== 'string' && value !== null ? { mono: true } : {}),
    });
  };
  for (const [key, value] of Object.entries(parsed)) visit(key, value);
  return rows.length > 0 ? rows : null;
}

export interface ToolResultView {
  readonly source: string;
  readonly language: 'json' | 'text';
}

/** 通用结果不猜测字段含义, Markdown 只由明确需要它的专用 UI 渲染. */
export function renderToolResult(result: unknown): ToolResultView {
  if (typeof result === 'string') {
    const trimmed = result.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return { source: JSON.stringify(JSON.parse(result), null, 2), language: 'json' };
      } catch {
        return { source: result, language: 'text' };
      }
    }
    return { source: result, language: 'text' };
  }
  return { source: JSON.stringify(result, null, 2) ?? '', language: 'json' };
}
