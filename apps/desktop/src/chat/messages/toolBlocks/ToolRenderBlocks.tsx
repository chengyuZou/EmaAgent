// 没有专属 UI 的 Tool 在这里显示参数、Markdown 结果和带语法色的 JSON 结果.
import { type JSX } from 'react';
import { Markdown, highlightCode } from '@ema-agent/ui';
import { renderToolArgs, renderToolResult, type ToolArgRow } from './tool-renderers.js';

function ToolRows({ rows }: { rows: readonly ToolArgRow[] }): JSX.Element {
  return (
    <dl className="ema-tool-field-list">
      {rows.map((row) => (
        <div key={row.key} className="ema-tool-field-row">
          <dt>{row.key}</dt>
          <dd className={row.mono ? 'ema-font-mono' : undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ToolArgsView({ args }: { args: unknown }): JSX.Element {
  const { rows } = renderToolArgs(args);
  if (rows.length === 0) return <span className="text-[11px] text-[var(--ema-text-tertiary)]">无参数</span>;
  return <ToolRows rows={rows} />;
}

/**
 * 渲染未注册专属 ResultView 的工具结果. 字符串继续走公共 Markdown, 深层对象走公共
 * highlight.js 主题, 避免每个 Tool 在聊天目录里再实现一次 Markdown 或 JSON 高亮.
 */
export function ToolResultViewBlock({ view }: { view: ReturnType<typeof renderToolResult> }): JSX.Element {
  if (view.kind === 'markdown') {
    return <Markdown source={view.source} className="ema-tool-result-markdown" />;
  }
  if (view.kind === 'rows') {
    return <ToolRows rows={view.rows} />;
  }

  const highlighted = highlightCode(view.source, view.language);
  return (
    <pre className="ema-tool-result-code hljs">
      <code dangerouslySetInnerHTML={{ __html: highlighted }} />
    </pre>
  );
}
