import type { JSX } from 'react';

// ── ToolSpecItem ─────────────────────────────────────────────────────────────
//
// MCP tool spec row: name + params + description + optional schema.
// Replaces the 3 duplicate white-box tool list items in McpTab (probe / expand / detail).

export interface ToolSpecItemProps {
  name:         string;
  params?:      string[];
  description?: string;
  schema?:      string;
}

export function ToolSpecItem({ name, params, description, schema }: ToolSpecItemProps): JSX.Element {
  return (
    <div className="rounded-lg px-2.5 py-1.5 bg-[var(--ema-surface-1)] border border-[var(--ema-border)]">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-mono font-medium text-[var(--ema-text-primary)]">{name}</span>
        {params && params.length > 0 && (
          <span className="text-[10px] text-[var(--ema-text-tertiary)] font-mono">({params.join(', ')})</span>
        )}
      </div>
      {description && <p className="text-[11px] text-[var(--ema-text-tertiary)] mt-0.5 line-clamp-2">{description}</p>}
      {schema && <pre className="text-[10px] text-[var(--ema-text-tertiary)] mt-1 overflow-auto max-h-40 whitespace-pre-wrap">{schema}</pre>}
    </div>
  );
}
