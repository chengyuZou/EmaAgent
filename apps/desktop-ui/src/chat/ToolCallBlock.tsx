/**
 * ToolCallBlock — collapsible tool invocation.
 *
 * Header: arrow · tool-name · primary-target · [status badge · duration] · [abort]
 * Body: 单块 — 参数(平铺 key-value) · 透明横线 · 结果(无 {}) · [error]
 *
 * 状态色：运行中黄/等待权限蓝/成功绿/失败红/已拒绝红（归失败色，文字区分）。
 * 耗时：流式用 startedAt 实时算，完成后用 durationMs（DB 持久化，刷新后保留）。
 */
import { useState, useEffect, useCallback, type JSX } from 'react';
import { createPatch } from 'diff';
import { IconButton } from '@ema-agent/ui';
import type { AssistantSlice } from '../stores/conversation-store.js';
import { turnsApi } from '../api/turns.js';
import { renderToolArgs, renderToolResult, stripOuterBraces } from './tool-renderers.js';

export interface ToolCallBlockProps {
  slice:      Extract<AssistantSlice, { type: 'tool_use' }>;
  streaming?: boolean;
  /** Turn ID — required to enable per-tool abort button. */
  turnId?:    string;
}

// ── 状态派生 ──────────────────────────────────────────────────────────────────

type ToolStatus = 'running' | 'awaiting_permission' | 'success' | 'failed' | 'denied';

function deriveStatus(slice: Extract<AssistantSlice, { type: 'tool_use' }>): ToolStatus {
  if (slice.error?.code === 'permission/denied') return 'denied';
  if (slice.error) return 'failed'; // policy/denied | tool/error | tool/not_found
  if (slice.permissionPromptId) return 'awaiting_permission';
  if (slice.result !== undefined) return 'success';
  return 'running';
}

const STATUS_META: Record<ToolStatus, { color: string; label: string; pulse?: boolean }> = {
  running:             { color: 'var(--ema-warning-text)', label: '运行中', pulse: true },
  awaiting_permission: { color: 'var(--ema-info-text)',    label: '等待确认', pulse: true },
  success:             { color: 'var(--ema-success-text)', label: '成功' },
  failed:              { color: 'var(--ema-danger-text)',  label: '失败' },
  denied:              { color: 'var(--ema-danger-text)',  label: '已拒绝' },
};

/** 毫秒 → 显示秒（<1s 显示一位小数，≥10s 取整，≥60s 显示 m:ss）。 */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

export function ToolCallBlock({ slice, streaming = false, turnId }: ToolCallBlockProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const hasResult   = slice.result !== undefined;
  const hasError    = !!slice.error;
  const status      = deriveStatus(slice);
  const statusMeta  = STATUS_META[status];
  const isStreaming = streaming && !hasResult && !hasError;
  const argsReady   = slice.args !== undefined;
  const isPending   = isStreaming && !argsReady;

  const target = argsReady ? getPrimaryTarget(slice.name, slice.args) : null;

  const isBash      = BASH_TOOLS.has(slice.name);
  const editDiff    = argsReady ? buildEditDiff(slice.name, slice.args) : null;

  const resultView = hasResult && slice.result !== null ? renderToolResult(slice.name, slice.result) : null;
  // bash 结果沿用原终端融合渲染（不进 renderToolResult）
  const bashResultStr = isBash && hasResult && slice.result !== null ? formatJson(slice.result) : null;

  const bodyForCopy = buildBodyText(slice, editDiff, isBash ? getBashCommand(slice.args) : null, bashResultStr, argsReady);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(bodyForCopy).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [bodyForCopy]);

  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      {/* ── Header ── */}
      <button
        className="flex items-center gap-2 text-left w-full group"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`text-[10px] w-3 shrink-0 ${open ? 'i-mdi:chevron-down' : 'i-mdi:chevron-right'}`} style={{ color: 'var(--ema-text-tertiary)' }} aria-hidden />

        <span className={`font-mono text-xs transition-colors ${
          hasError   ? 'text-[var(--ema-danger)]' :
          isPending  ? 'text-[var(--ema-warning)] animate-pulse' :
                       'text-[var(--ema-text-secondary)] group-hover:text-[var(--ema-text-primary)]'
        }`}>
          {slice.name}
        </span>

        {target && (
          <span className="text-xs font-mono truncate max-w-[18rem]" style={{ color: 'var(--ema-text-tertiary)' }}>
            · {target}
          </span>
        )}

        {/* 状态徽章 + 耗时（右侧） */}
        <span className="ml-auto flex items-center gap-1.5 text-[10px] shrink-0" style={{ color: statusMeta.color }}>
          <span
            className={`w-1.5 h-1.5 rounded-full ${statusMeta.pulse ? 'animate-pulse' : ''}`}
            style={{ background: statusMeta.color }}
            aria-hidden
          />
          {statusMeta.label}
          <StatusDuration status={status} durationMs={slice.durationMs} startedAt={slice.startedAt} />
        </span>

        {isPending && turnId && (
          <span className="ema-chip-in shrink-0">
            <IconButton
              label="中止该工具"
              icon="i-mdi:stop-circle-outline"
              variant="danger"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                void turnsApi.abortTool(turnId, slice.callId);
              }}
            />
          </span>
        )}
      </button>

      {/* ── Expanded body — grid-rows trick for smooth height animation ── */}
      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="relative ml-3 pl-3" style={{ borderLeftColor: 'var(--ema-border)', borderLeftWidth: 1 }}>
          {/* Copy button */}
          <button
            className="absolute top-0 right-0 px-1.5 py-0.5 rounded text-[10px] transition-colors text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-2)]"
            onClick={(e) => { e.stopPropagation(); copy(); }}
          >
            {copied ? <span className="i-mdi:check text-xs" aria-hidden /> : <span className="i-mdi:content-copy text-xs" aria-hidden />}
          </button>

          {/* Bash: 融合终端视图（命令 + 输出，不走通用平铺） */}
          {isBash && (
            <div className="max-h-64 overflow-auto pr-6">
              <BashBlock cmd={getBashCommand(slice.args) ?? ''} output={bashResultStr} partialArgs={slice.partialArgs} isPending={isPending} />
            </div>
          )}

          {/* Edit diff */}
          {!isBash && editDiff && (
            <div className="max-h-64 overflow-auto pr-6">
              <DiffBlock code={editDiff} />
            </div>
          )}

          {/* 通用工具：单块 = 参数 + 透明横线 + 结果 */}
          {!isBash && !editDiff && (
            <>
              {/* 参数区 */}
              {argsReady ? (
                <ToolArgsView name={slice.name} args={slice.args} />
              ) : slice.partialArgs ? (
                <pre className="font-mono text-[11px] text-[var(--ema-text-tertiary)] whitespace-pre-wrap break-all leading-relaxed bg-transparent m-0 p-0 pr-6">
                  {slice.partialArgs}
                </pre>
              ) : null}

              {/* 透明横线（分隔参数与结果，仅当两者都有时） */}
              {(argsReady || slice.partialArgs) && resultView !== null && (
                <div className="my-2 mx-4 border-t border-[var(--ema-border)]" />
              )}

              {/* 结果区 */}
              {resultView !== null && (
                <div className="max-h-48 overflow-auto pr-6">
                  <ToolResultViewBlock view={resultView} />
                </div>
              )}

              {/* 错误区（denied/failed 状态） */}
              {hasError && (
                <div className="border-l-2 pl-2 mt-1" style={{ borderColor: 'var(--ema-danger)' }}>
                  <pre className="font-mono text-[11px] whitespace-pre-wrap break-all bg-transparent m-0 p-0"
                       style={{ color: 'var(--ema-danger-text)' }}>
                    {status === 'denied' ? '已拒绝' : `[${slice.error!.code}]`} {slice.error!.message}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── StatusDuration（实时耗时 hook）────────────────────────────────────────────

function StatusDuration({
  status, durationMs, startedAt,
}: {
  status: ToolStatus;
  durationMs?: number;
  startedAt?: number;
}): JSX.Element | null {
  // 运行中：用 startedAt 实时算
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== 'running' || !startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [status, startedAt]);

  if (status === 'running' && startedAt) {
    return <span className="tabular-nums">· {fmtDuration(now - startedAt)}</span>;
  }
  if (durationMs != null && (status === 'success' || status === 'failed' || status === 'denied')) {
    return <span className="tabular-nums">· {fmtDuration(durationMs)}</span>;
  }
  // awaiting_permission / 无耗时的 failed / denied（durationMs 为 0 也不显示）
  return null;
}

// ── ToolArgsView（参数平铺，无 {}）────────────────────────────────────────────

function ToolArgsView({ name, args }: { name: string; args: unknown }): JSX.Element {
  const { rows } = renderToolArgs(name, args);
  if (rows.length === 0) return <span className="text-[11px]" style={{ color: 'var(--ema-text-tertiary)' }}>（无参数）</span>;
  return (
    <div className="flex flex-col gap-0.5 pr-6">
      {rows.map((r, i) => (
        <div key={i} className="flex items-baseline gap-2 text-[11px] leading-relaxed">
          <span style={{ color: 'var(--ema-text-tertiary)' }} className="shrink-0">{r.key}:</span>
          <span className={`break-all ${r.mono ? 'font-mono' : ''}`} style={{ color: 'var(--ema-text-secondary)' }}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── ToolResultViewBlock（结果区，按 kind 分派）────────────────────────────────

function ToolResultViewBlock({ view }: { view: ReturnType<typeof renderToolResult> }): JSX.Element {
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
            <span style={{ color: 'var(--ema-text-tertiary)' }} className="shrink-0">{r.key}:</span>
            <span className={`break-all ${r.mono ? 'font-mono' : ''}`} style={{ color: 'var(--ema-text-secondary)' }}>
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

// ── BashBlock ─────────────────────────────────────────────────────────────────

function BashBlock({ cmd, output, partialArgs, isPending }: {
  cmd: string; output: string | null; partialArgs?: string; isPending: boolean;
}): JSX.Element {
  const displayCmd = cmd || partialArgs || '';
  return (
    <pre className="font-mono text-[11px] whitespace-pre-wrap break-all leading-relaxed bg-transparent m-0 p-0">
      {displayCmd && (
        <span className="text-[var(--ema-syntax-prompt)]">{'$ '}{displayCmd}</span>
      )}
      {isPending && <span className="text-[var(--ema-text-tertiary)] animate-pulse"> ▌</span>}
      {output !== null && (
        <>
          {'\n\n'}
          <span className="text-[var(--ema-text-secondary)]">{output}</span>
        </>
      )}
    </pre>
  );
}

// ── JsonBlock（raw 结果高亮，外层 {} 已由调用方剥除）──────────────────────────

function JsonBlock({ code }: { code: string }): JSX.Element {
  const parts = tokenizeJson(code);
  return (
    <pre className="font-mono text-[11px] whitespace-pre-wrap break-all leading-relaxed bg-transparent m-0 p-0">
      {parts.map((p, i) => (
        <span key={i} className={JSON_COLORS[p.type]}>{p.text}</span>
      ))}
    </pre>
  );
}

const JSON_COLORS: Record<string, string> = {
  key:         'text-[var(--ema-syntax-key)]',
  string:      'text-[var(--ema-syntax-string)]',
  number:      'text-[var(--ema-syntax-number)]',
  boolean:     'text-[var(--ema-syntax-boolean)]',
  null:        'text-[var(--ema-syntax-comment)]',
  punctuation: 'text-[var(--ema-syntax-comment)]',
  plain:       'text-[var(--ema-text-secondary)]',
};

type JsonToken = { type: string; text: string };

function tokenizeJson(code: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0;
  const n = code.length;
  const ch = (): string => code.charAt(i);

  while (i < n) {
    if (/[\s\[\]{}:,]/.test(ch())) {
      const start = i;
      while (i < n && /[\s\[\]{}:,]/.test(ch())) i++;
      tokens.push({ type: 'punctuation', text: code.slice(start, i) });
      continue;
    }

    if (ch() === '"') {
      const start = i++;
      while (i < n) {
        if (ch() === '\\') { i += 2; continue; }
        if (ch() === '"') { i++; break; }
        i++;
      }
      const raw = code.slice(start, i);
      let j = i;
      while (j < n && code.charAt(j) === ' ') j++;
      const isKey = code.charAt(j) === ':';
      tokens.push({ type: isKey ? 'key' : 'string', text: raw });
      continue;
    }

    if (/[-\d]/.test(ch())) {
      const start = i;
      while (i < n && /[\d.eE+\-]/.test(ch())) i++;
      tokens.push({ type: 'number', text: code.slice(start, i) });
      continue;
    }

    let matched = false;
    for (const kw of ['true', 'false', 'null']) {
      if (code.startsWith(kw, i)) {
        tokens.push({ type: kw === 'null' ? 'null' : 'boolean', text: kw });
        i += kw.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      tokens.push({ type: 'plain', text: ch() });
      i++;
    }
  }
  return tokens;
}

function DiffBlock({ code }: { code: string }): JSX.Element {
  return (
    <pre className="font-mono text-[11px] whitespace-pre-wrap break-all leading-relaxed bg-transparent m-0 p-0">
      {code.split('\n').map((line, i) => {
        const cls =
          line.startsWith('+') && !line.startsWith('+++') ? 'text-[var(--ema-success-text)]' :
          line.startsWith('-') && !line.startsWith('---') ? 'text-[var(--ema-danger-text)]' :
          line.startsWith('@@')                           ? 'text-[var(--ema-info-text)]' :
                                                            'text-[var(--ema-text-tertiary)]';
        return <span key={i} className={cls}>{line}{'\n'}</span>;
      })}
    </pre>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASH_TOOLS = new Set(['bash', 'powershell', 'run_command', 'execute_bash', 'shell']);
const EDIT_TOOLS = new Set(['edit_file', 'str_replace', 'str_replace_editor', 'apply_diff', 'patch']);

function getBashCommand(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  return typeof (a.command ?? a.cmd) === 'string' ? String(a.command ?? a.cmd) : '';
}

function buildBodyText(
  slice: Extract<AssistantSlice, { type: 'tool_use' }>,
  editDiff: string | null,
  bashCmd: string | null,
  bashResultStr: string | null,
  argsReady: boolean,
): string {
  // 复制时保留完整 JSON（含 {}）—— 复制粘贴场景需要可解析的结构化数据
  if (BASH_TOOLS.has(slice.name)) {
    const parts: string[] = [];
    if (bashCmd) parts.push(`$ ${bashCmd}`);
    if (bashResultStr !== null) parts.push('', bashResultStr);
    return parts.join('\n');
  }
  if (editDiff) return editDiff;
  const parts: string[] = [];
  if (argsReady) parts.push(formatJson(slice.args));
  if (slice.result !== undefined && slice.result !== null) parts.push(formatJson(slice.result));
  return parts.join('\n\n');
}

function buildEditDiff(name: string, args: unknown): string | null {
  if (!EDIT_TOOLS.has(name) || !args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const oldStr = typeof a.old_str === 'string' ? a.old_str
               : typeof a.old_string === 'string' ? a.old_string
               : null;
  const newStr = typeof a.new_str === 'string' ? a.new_str
               : typeof a.new_string === 'string' ? a.new_string
               : null;
  if (oldStr === null || newStr === null) return null;
  const filePath = typeof (a.path ?? a.file_path) === 'string'
    ? String(a.path ?? a.file_path) : 'file';
  return createPatch(filePath, oldStr, newStr, '', '', { context: 3 });
}

function getPrimaryTarget(name: string, args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  const path = str(a.path ?? a.file_path ?? a.filepath ?? a.target_file ?? a.filename ?? '');

  if (['read', 'read_file', 'write', 'write_file', 'view'].includes(name) && path) return path;
  if (EDIT_TOOLS.has(name) && path) return path;
  if (name === 'glob' || name === 'list_files') return str(a.pattern ?? a.glob ?? a.path ?? '');

  if (name === 'grep' || name === 'search_files') {
    const pat = str(a.pattern ?? a.query ?? '');
    return path ? `${pat} in ${path}` : pat;
  }

  if (BASH_TOOLS.has(name)) {
    const cmd = str(a.command ?? a.cmd ?? '');
    return (cmd.split('\n')[0] ?? '').slice(0, 60);
  }

  if (['web_search', 'search'].includes(name)) return str(a.query ?? '');
  if (['web_fetch', 'fetch', 'url_fetch'].includes(name)) return str(a.url ?? '');

  const first = Object.values(a).find(v => typeof v === 'string' && v.length > 0);
  return first ? String(first).slice(0, 60) : null;
}

function formatJson(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}
