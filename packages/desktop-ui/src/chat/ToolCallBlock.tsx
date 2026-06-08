/**
 * ToolCallBlock — collapsible tool invocation. Ported from AIRI tool-call-block.vue
 *
 * Status logic:
 *   - streaming=true  + no result → "运行中" (actively waiting)
 *   - streaming=false + no result → "完成"   (historical — DB doesn't store tool_result in assistant blocks)
 *   - any            + result     → "完成"
 *   - any            + error      → "失败"
 */
import { useState, type JSX } from 'react';
import type { AssistantSlice } from '../stores/conversation-store.js';

export interface ToolCallBlockProps {
  slice:      AssistantSlice & { type: 'tool_use' };
  streaming?: boolean;  // true only when this bubble is the live stream
}

export function ToolCallBlock({ slice, streaming = false }: ToolCallBlockProps): JSX.Element {
  const [open, setOpen] = useState(false);

  // null = "completed, no output"  |  undefined = "not yet received"
  const hasResult = slice.result !== undefined;
  const hasError  = !!slice.error;
  // Pending only when actively streaming AND no result/error yet
  const isPending = streaming && !hasResult && !hasError;

  const badge = isPending
    ? { label: '运行中', cls: 'bg-yellow-400/20 text-yellow-300' }
    : hasError
    ? { label: '失败',   cls: 'bg-red-400/20 text-red-300' }
    : { label: '完成',   cls: 'bg-green-400/20 text-green-300' };

  const argsStr   = formatJson(slice.args);
  const resultStr = hasResult && slice.result !== null ? formatJson(slice.result) : null;

  return (
    <div className="rounded-lg px-2 pt-2 pb-2 bg-pink-900/60 flex flex-col gap-2 items-start">
      {/* Trigger */}
      <button
        className="w-full text-start flex items-center gap-2"
        onClick={() => setOpen(!open)}
      >
        <span className="text-gray-400 text-xs">{open ? '▼' : '▶'}</span>
        <span className="font-mono text-xs text-pink-200/80">🔧 {slice.name}</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ml-auto flex items-center gap-1 ${badge.cls}`}>
          {isPending && (
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
          )}
          {badge.label}
        </span>
      </button>

      {/* Expanded body */}
      {open && (
        <div className="w-full flex flex-col gap-2">
          {/* Args */}
          <div className="rounded-md p-2 w-full bg-gray-900/80 text-sm text-gray-200">
            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">参数</div>
            <pre className="font-mono text-xs whitespace-pre-wrap break-words">{argsStr}</pre>
          </div>

          {/* Error */}
          {hasError && (
            <div className="rounded-md p-2 w-full bg-red-900/40 text-sm text-red-200">
              <div className="text-[10px] text-red-400 uppercase tracking-wide mb-1">错误</div>
              <pre className="font-mono text-xs whitespace-pre-wrap break-words">
                [{slice.error!.code}] {slice.error!.message}
              </pre>
            </div>
          )}

          {/* Result — only when we actually have output (null = no output, skip) */}
          {resultStr !== null && (
            <div className="rounded-md p-2 w-full bg-gray-900/80 text-sm text-gray-200">
              <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">结果</div>
              <pre className="font-mono text-xs whitespace-pre-wrap break-words max-h-48 overflow-auto">{resultStr}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatJson(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}
