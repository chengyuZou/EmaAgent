// RawCommandPanel — 等宽完整展示工具名与原始参数 JSON。
export interface RawCommandPanelProps {
  toolName: string;
  args: unknown;
}

export function RawCommandPanel({ toolName, args }: RawCommandPanelProps): JSX.Element {
  const argsStr = typeof args === 'string'
    ? args
    : JSON.stringify(args, null, 2);

  return (
    <div
      className="mt-3 rounded-xl p-3 font-mono text-xs overflow-auto max-h-60 bg-[var(--ema-bg)] text-[var(--ema-text-secondary)]"
      style={{ border: '1px solid var(--ema-border)' }}
    >
      <div className="font-semibold mb-1 text-[var(--ema-primary)]">{toolName}</div>
      <pre className="whitespace-pre-wrap">{argsStr}</pre>
    </div>
  );
}
