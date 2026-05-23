/** RawCommandPanel — display toolName + JSON args in monospace, unfolded. */
export interface RawCommandPanelProps {
  toolName: string;
  args: unknown;
}

export function RawCommandPanel({ toolName, args }: RawCommandPanelProps): JSX.Element {
  const argsStr = typeof args === 'string'
    ? args
    : JSON.stringify(args, null, 2);

  return (
    <div className="mt-3 bg-gray-800 border border-gray-600 rounded-xl p-3 font-mono text-xs text-gray-300 overflow-auto max-h-60">
      <div className="text-pink-400 font-semibold mb-1">{toolName}</div>
      <pre className="whitespace-pre-wrap">{argsStr}</pre>
    </div>
  );
}
