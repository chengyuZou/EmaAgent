/**
 * ToolCallBlock — collapsible tool invocation.
 *
 * Header: arrow · tool-name · primary-target · [copy]
 * Bash: `$ cmd` blank-line output in one block.
 * Edit: unified diff.
 * Others: args then result, no section labels.
 */
import { useState, useCallback, type JSX } from 'react';
import { createPatch } from 'diff';
import { IconButton } from '@ema-agent/ui';
import type { AssistantSlice } from '../stores/conversation-store.js';
import { turnsApi } from '../api/turns.js';

export interface ToolCallBlockProps {
  slice:      Extract<AssistantSlice, { type: 'tool_use' }>;
  streaming?: boolean;
  /** Turn ID — required to enable per-tool abort button. */
  turnId?:    string;
}

export function ToolCallBlock({ slice, streaming = false, turnId }: ToolCallBlockProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const hasResult   = slice.result !== undefined;
  const hasError    = !!slice.error;
  const isStreaming = streaming && !hasResult && !hasError;
  const argsReady   = slice.args !== undefined;
  const isPending   = isStreaming && !argsReady;

  const target = argsReady ? getPrimaryTarget(slice.name, slice.args) : null;

  const isBash      = BASH_TOOLS.has(slice.name);
  const editDiff    = argsReady ? buildEditDiff(slice.name, slice.args) : null;
  const argsLang: CodeLang = editDiff ? 'diff'
                           : isBash   ? 'shell'
                           : detectArgsLang(slice.name, slice.args);

  const resultStr  = hasResult && slice.result !== null ? formatJson(slice.result) : null;
  const resultLang = detectResultLang(slice.name, slice.args, slice.result);

  // For bash: fuse command + output into one terminal block.
  const bashCmd   = isBash && argsReady ? getBashCommand(slice.args) : null;
  const bodyForCopy = buildBodyText(slice, editDiff, bashCmd, resultStr, argsReady);

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
        <span className="text-[10px] w-3 shrink-0" style={{ color: 'var(--ema-text-tertiary)' }}>
          {open ? '▾' : '▸'}
        </span>

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

        {isPending && (
          <span className="ml-auto flex items-center gap-1 text-[10px] shrink-0" style={{ color: 'var(--ema-warning)' }}>
            <span className="w-1 h-1 rounded-full animate-pulse" style={{ background: 'var(--ema-warning)' }} />
            运行中
          </span>
        )}

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
            className="absolute top-0 right-0 px-1.5 py-0.5 rounded text-[10px] transition-colors"
            style={{ color: 'var(--ema-text-tertiary)' }}
            onMouseEnter={(e) => { const t = e.currentTarget as HTMLElement; t.style.color = 'var(--ema-text-primary)'; t.style.background = 'var(--ema-surface-2)'; }}
            onMouseLeave={(e) => { const t = e.currentTarget as HTMLElement; t.style.color = 'var(--ema-text-tertiary)'; t.style.background = ''; }}
            onClick={(e) => { e.stopPropagation(); copy(); }}
          >
            {copied ? '✓' : '⎘'}
          </button>

          {/* Bash: fused terminal view */}
          {isBash && (
            <div className="max-h-64 overflow-auto pr-6">
              <BashBlock cmd={bashCmd ?? ''} output={resultStr} partialArgs={slice.partialArgs} isPending={isPending} />
            </div>
          )}

          {/* Edit diff */}
          {!isBash && editDiff && (
            <div className="max-h-64 overflow-auto pr-6">
              <DiffBlock code={editDiff} />
            </div>
          )}

          {/* Generic tool: args */}
          {!isBash && !editDiff && argsReady && (
            <div className={resultStr !== null ? 'mb-2' : ''}>
              {isPending && <span className="w-1 h-1 rounded-full animate-pulse inline-block mb-1" style={{ background: 'var(--ema-warning)' }} />}
              <CodeBlock code={formatJson(slice.args)} lang={argsLang} />
            </div>
          )}

          {/* Partial streaming args */}
          {!isBash && !editDiff && !argsReady && slice.partialArgs && (
            <pre className="font-mono text-[11px] text-neutral-400 whitespace-pre-wrap break-all leading-relaxed bg-transparent m-0 p-0 pr-6">
              {slice.partialArgs}
            </pre>
          )}

          {/* Error */}
          {hasError && (
            <div className="border-l-2 pl-2 mt-1" style={{ borderColor: 'var(--ema-danger)' }}>
              <pre className="font-mono text-[11px] whitespace-pre-wrap break-all bg-transparent m-0 p-0"
                   style={{ color: 'var(--ema-danger-text)' }}>
                [{slice.error!.code}] {slice.error!.message}
              </pre>
            </div>
          )}

          {/* Generic result */}
          {!isBash && resultStr !== null && (
            <div className="max-h-48 overflow-auto pr-6">
              <CodeBlock code={resultStr} lang={resultLang} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── BashBlock ─────────────────────────────────────────────────────────────────

function BashBlock({ cmd, output, partialArgs, isPending }: {
  cmd: string; output: string | null; partialArgs?: string; isPending: boolean;
}): JSX.Element {
  const displayCmd = cmd || partialArgs || '';
  return (
    <pre className="font-mono text-[11px] whitespace-pre-wrap break-all leading-relaxed bg-transparent m-0 p-0">
      {displayCmd && (
        <span className="text-yellow-300/90">{'$ '}{displayCmd}</span>
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

// ── CodeBlock ─────────────────────────────────────────────────────────────────

type CodeLang = 'json' | 'diff' | 'shell' | 'plain';

function CodeBlock({ code, lang }: { code: string; lang: CodeLang }): JSX.Element {
  if (lang === 'json') return <JsonBlock code={code} />;
  if (lang === 'diff') return <DiffBlock code={code} />;
  if (lang === 'shell') return <ShellBlock code={code} />;
  return (
    <pre className="font-mono text-[11px] text-neutral-300 whitespace-pre-wrap break-all leading-relaxed bg-transparent m-0 p-0">
      {code}
    </pre>
  );
}

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
  key:         'text-blue-300',
  string:      'text-emerald-300',
  number:      'text-orange-300',
  boolean:     'text-violet-300',
  null:        'text-neutral-500',
  punctuation: 'text-neutral-500',
  plain:       'text-neutral-300',
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
          line.startsWith('+') && !line.startsWith('+++') ? 'text-emerald-400' :
          line.startsWith('-') && !line.startsWith('---') ? 'text-red-400' :
          line.startsWith('@@')                           ? 'text-blue-300/70' :
                                                            'text-neutral-500';
        return <span key={i} className={cls}>{line}{'\n'}</span>;
      })}
    </pre>
  );
}

function ShellBlock({ code }: { code: string }): JSX.Element {
  return (
    <pre className="font-mono text-[11px] whitespace-pre-wrap break-all leading-relaxed bg-transparent m-0 p-0">
      {code.split('\n').map((line, i) => {
        const isCmd = /^\s*\$/.test(line);
        return (
          <span key={i} className={isCmd ? 'text-yellow-300' : 'text-neutral-300'}>{line}{'\n'}</span>
        );
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
  resultStr: string | null,
  argsReady: boolean,
): string {
  if (BASH_TOOLS.has(slice.name)) {
    const parts: string[] = [];
    if (bashCmd) parts.push(`$ ${bashCmd}`);
    if (resultStr !== null) parts.push('', resultStr);
    return parts.join('\n');
  }
  if (editDiff) return editDiff;
  const parts: string[] = [];
  if (argsReady) parts.push(formatJson(slice.args));
  if (resultStr !== null) parts.push(resultStr);
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

function detectArgsLang(_name: string, args: unknown): CodeLang {
  if (!args || typeof args !== 'object') return 'plain';
  return 'json';
}

function detectResultLang(name: string, _args: unknown, result: unknown): CodeLang {
  if (BASH_TOOLS.has(name)) return 'shell';
  if (EDIT_TOOLS.has(name)) return 'plain';
  if (typeof result === 'object' && result !== null) return 'json';
  if (typeof result === 'string') {
    const trimmed = result.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  }
  return 'plain';
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
