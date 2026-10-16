import type { JSX } from 'react';
import { CodeViewer } from '@ema-agent/ui';
import type { ToolArgRow, ToolResultView } from './tool-renderers.js';

export function ToolRows({ rows }: { rows: readonly ToolArgRow[] }): JSX.Element {
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

export function ToolArgsView({ source }: { source: string }): JSX.Element {
  if (!source || source === '{}' || source === 'null') {
    return <span className="text-[11px] text-[var(--ema-text-tertiary)]">无参数</span>;
  }
  return <CodeViewer source={source} language="json" embedded />;
}

export function ToolResultViewBlock({ view }: { view: ToolResultView }): JSX.Element {
  return <CodeViewer source={view.source} language={view.language} embedded wrapLines={false} />;
}
