// Tool 块的五个渲染件:参数平铺、结果分派、Bash 终端卡、JSON 高亮与 diff 上色。
import { useState, type JSX } from 'react';
import { renderToolArgs, renderToolResult, stripOuterBraces } from './tool-renderers.js';
import { JSON_COLORS, tokenizeJson } from './jsonTokenize.js';

export function ToolArgsView({ name, args }: { name: string; args: unknown }): JSX.Element {
  const { rows } = renderToolArgs(name, args);
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

// ── BashBlock（终端卡：banner 固定 + 输出独立滚动不换行） ─────────────────────

export type TerminalStatus = 'running' | 'awaiting_permission' | 'success' | 'failed' | 'denied';

const TERMINAL_PILL: Readonly<Record<TerminalStatus, { label: string; color: string }>> = {
  running: { label: '运行中', color: 'var(--ema-warning-text)' },
  awaiting_permission: { label: '等待确认', color: 'var(--ema-info-text)' },
  success: { label: '成功', color: 'var(--ema-success-text)' },
  failed: { label: '失败', color: 'var(--ema-danger-text)' },
  denied: { label: '已拒绝', color: 'var(--ema-danger-text)' },
};

export function BashBlock({ cmd, output, partialArgs, isPending, status }: {
  cmd: string;
  output: string | null;
  partialArgs?: string;
  isPending: boolean;
  status: TerminalStatus;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const displayCmd = cmd || partialArgs || '';
  const pill = TERMINAL_PILL[status];

  const copyAll = (): void => {
    const text = [`$ ${displayCmd}`, ...(output !== null ? ['', output] : [])].join('\n');
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    });
  };

  return (
    <div className="ema-terminal-card">
      <div className="ema-terminal-banner">
        <span className="ema-terminal-gutter-dot" style={{ background: pill.color }} aria-hidden />
        <code className="ema-terminal-cmd" title={displayCmd}>$ {displayCmd}</code>
        <span className="ema-terminal-pill" style={{ color: pill.color }}>{pill.label}</span>
        <button
          type="button"
          className="ema-terminal-copy"
          aria-label="复制命令与输出"
          onClick={(e) => { e.stopPropagation(); copyAll(); }}
        >
          <span className={copied ? 'i-lucide:check' : 'i-lucide:copy'} aria-hidden />
        </button>
      </div>
      {(output !== null || isPending) && (
        <div className="ema-terminal-output">
          <pre>
            {output}
            {isPending && <span className="text-[var(--ema-text-tertiary)] animate-pulse"> ▌</span>}
          </pre>
        </div>
      )}
    </div>
  );
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

export function DiffBlock({ code }: { code: string }): JSX.Element {
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