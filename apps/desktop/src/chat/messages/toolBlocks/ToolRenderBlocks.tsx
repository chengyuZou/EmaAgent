// Tool 块的通用回退渲染件: 参数平铺、结果分派与 JSON 高亮。
// 终端卡与 diff 卡归各 Tool 自己的 UI.tsx，这里只服务没有专属 UI 的 MCP/未知工具。
import { type JSX } from 'react';
import { renderToolArgs, renderToolResult, stripOuterBraces } from './tool-renderers.js';
import { JSON_COLORS, tokenizeJson } from './jsonTokenize.js';

export function ToolArgsView({ args }: { args: unknown }): JSX.Element {
  const { rows } = renderToolArgs(args);
  if (rows.length === 0) return <span className="text-[11px] text-[var(--ema-text-tertiary)]">（无参数）</span>;
  return (
    <div className="flex flex-col gap-0.5 pr-6">
      {rows.map((r, i) => (
        <div key={i} className="flex items-baseline gap-2 text-[11px] leading-relaxed">
          <span className="shrink-0 text-[var(--ema-text-tertiary)]">{r.key}:</span>
          <span className={`break-all ${r.mono ? 'font-mono' : ''} text-[var(--ema-text-secondary)]`}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ToolResultViewBlock({ view }: { view: ReturnType<typeof renderToolResult> }): JSX.Element {
  if (view.kind === 'text') {
    return (
      <pre className="font-mono text-[11px] text-[var(--ema-text-secondary)] whitespace-pre-wrap break-all leading-relaxed bg-transparent m-0 p-0">
        {view.text}
      </pre>
    );
  }
  if (view.kind === 'rows') {
    return (
      <div className="flex flex-col gap-0.5">
        {view.rows.map((r, i) => (
          <div key={i} className="flex items-baseline gap-2 text-[11px] leading-relaxed">
            <span className="shrink-0 text-[var(--ema-text-tertiary)]">{r.key}:</span>
            <span className={`break-all ${r.mono ? 'font-mono' : ''} text-[var(--ema-text-secondary)]`}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
    );
  }
  // raw：JsonBlock 高亮，但剥外层 {}
  return <JsonBlock code={stripOuterBraces(view.text)} />;
}

export function JsonBlock({ code }: { code: string }): JSX.Element {
  const parts = tokenizeJson(code);
  return (
    <pre className="font-mono text-[11px] whitespace-pre-wrap break-all leading-relaxed bg-transparent m-0 p-0">
      {parts.map((p, i) => (
        <span key={i} className={JSON_COLORS[p.type]}>{p.text}</span>
      ))}
    </pre>
  );
}
