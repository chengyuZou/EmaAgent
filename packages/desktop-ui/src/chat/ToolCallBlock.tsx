/** ToolCallBlock — collapsible tool invocation with status badge + args/result. */
import { useState } from 'react';
import type { AssistantSlice } from '../stores/chat-store.js';

export interface ToolCallBlockProps {
  slice: AssistantSlice & { type: 'tool_call' };
}

export function ToolCallBlock({ slice }: ToolCallBlockProps): JSX.Element {
  const [open, setOpen] = useState(false);

  const hasResult = slice.result !== undefined;
  const hasError  = !!slice.error;
  const isPending = !hasResult && !hasError;

  const statusBadge = isPending
    ? { label: '运行中', color: 'bg-yellow-400/20 text-yellow-300' }
    : hasError
    ? { label: '失败',   color: 'bg-red-400/20 text-red-300' }
    : { label: '完成',   color: 'bg-green-400/20 text-green-300' };

  const argsStr = typeof slice.args === 'string'
    ? slice.args
    : JSON.stringify(slice.args, null, 2);

  const resultStr = slice.result !== undefined
    ? typeof slice.result === 'string'
      ? slice.result
      : JSON.stringify(slice.result, null, 2)
    : '';

  return (
    <div className="my-1.5">
      <button
        className="flex items-center gap-2 text-sm w-full text-left group"
        onClick={() => setOpen(!open)}
      >
        <span className="text-xs text-gray-500">{open ? '▼' : '▶'}</span>
        <span className="font-mono text-xs text-gray-400">🔧 {slice.name}</span>
        <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium ${statusBadge.color}`}>
          {isPending && <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse mr-1 align-middle" />}
          {statusBadge.label}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 pl-6 border-l-2 border-gray-700">
          {/* Args */}
          <div className="mb-1.5">
            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">参数</div>
            <pre className="bg-gray-900 rounded-lg p-2 text-xs text-gray-300 font-mono overflow-auto max-h-32 whitespace-pre-wrap">
              {argsStr}
            </pre>
          </div>

          {/* Error */}
          {hasError && (
            <div className="mb-1.5">
              <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">错误</div>
              <pre className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-xs text-red-300 font-mono overflow-auto max-h-32 whitespace-pre-wrap">
                [{slice.error!.code}] {slice.error!.message}
              </pre>
            </div>
          )}

          {/* Result */}
          {hasResult && (
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">结果</div>
              <pre className="bg-gray-900 rounded-lg p-2 text-xs text-gray-300 font-mono overflow-auto max-h-48 whitespace-pre-wrap">
                {resultStr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
