// BashTool 的桌面展示：终端卡接管整个展开区（命令 banner + 输出区），
// 后台转交卡、行头摘要、复制文本与实时输出尾巴也各归本文件。
// 守卫失败返回 null，由前端回落通用渲染。
import { useState, type JSX } from 'react';
import type {
  BashCommandResult,
  BashProcessReference,
  BashProgress,
} from './BashTool.js';

// ── 入参与守卫 ────────────────────────────────────────────────────────────────

/** 终端卡展示状态：pill 的渲染语汇，由前端外壳从执行事实推导。 */
export type BashCallStatus = 'running' | 'awaiting_permission' | 'success' | 'failed' | 'denied';

export interface BashCallViewProps {
  readonly args: unknown;
  readonly partialArgs?: string;
  readonly data?: unknown;
  /** 原始 BashProgress 事件序列（至多保留尾部若干条，由前端外壳截断）。 */
  readonly progress?: readonly unknown[];
  readonly status: BashCallStatus;
  readonly running: boolean;
  /** 打开后台进程面板；导航动作由前端外壳提供。 */
  openBackgroundProcesses(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asBashCommandResult(data: unknown): BashCommandResult | null {
  if (!isRecord(data) || data['kind'] !== 'commandResult') return null;
  if (typeof data['stdout'] !== 'string' || typeof data['stderr'] !== 'string') return null;
  return data as unknown as BashCommandResult;
}

export function asBashProcessReference(data: unknown): BashProcessReference | null {
  if (!isRecord(data) || data['kind'] !== 'processReference') return null;
  if (typeof data['backgroundProcessId'] !== 'string') return null;
  return data as unknown as BashProcessReference;
}

function asBashProgress(progress: unknown): BashProgress | null {
  if (!isRecord(progress)) return null;
  const stream = progress['stream'];
  if ((stream !== 'stdout' && stream !== 'stderr') || typeof progress['text'] !== 'string') {
    return null;
  }
  return progress as unknown as BashProgress;
}

function commandFromArgs(args: unknown): string {
  if (!isRecord(args) || typeof args['command'] !== 'string') return '';
  return args['command'];
}

// ── 外壳钩子 ──────────────────────────────────────────────────────────────────

/** 行头摘要：命令首行，最多 60 字。 */
export function bashTitle(args: unknown): string | null {
  const command = commandFromArgs(args);
  if (!command) return null;
  const firstLine = command.split('\n')[0] ?? '';
  return firstLine.length > 60 ? firstLine.slice(0, 60) : firstLine;
}

/** 命令结果 → 终端文本：stdout、stderr 与 note 依序拼接。 */
export function bashResultText(result: BashCommandResult): string {
  const parts: string[] = [];
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
  if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
  if (result.note) parts.push(result.note);
  return parts.join('\n');
}

/** 复制文本：`$ 命令` + 输出；后台转交引用没有可复制输出。 */
export function bashCopyText(args: unknown, data: unknown): string | null {
  const command = commandFromArgs(args);
  if (!command) return null;
  const result = asBashCommandResult(data);
  const output = result ? bashResultText(result) : null;
  return [`$ ${command}`, ...(output ? ['', output] : [])].join('\n');
}

/** 实时输出尾巴：拼接进度事件的文本增量，只留末尾一段。 */
function bashProgressTail(progress: readonly unknown[]): string {
  let text = '';
  for (const entry of progress) {
    const chunk = asBashProgress(entry);
    if (chunk) text += chunk.text;
  }
  const TAIL_MAX = 4000;
  return text.length > TAIL_MAX ? text.slice(-TAIL_MAX) : text;
}

// ── 展开区（终端卡 + 后台转交卡） ─────────────────────────────────────────────

const PILL: Readonly<Record<BashCallStatus, { label: string; color: string }>> = {
  running: { label: '运行中', color: 'var(--ema-warning-text)' },
  awaiting_permission: { label: '等待确认', color: 'var(--ema-info-text)' },
  success: { label: '成功', color: 'var(--ema-success-text)' },
  failed: { label: '失败', color: 'var(--ema-danger-text)' },
  denied: { label: '已拒绝', color: 'var(--ema-danger-text)' },
};

export function BashCallView(props: BashCallViewProps): JSX.Element {
  const command = commandFromArgs(props.args) || props.partialArgs || '';
  const processRef = asBashProcessReference(props.data);
  if (processRef) {
    return (
      <BashBackgroundCard
        command={command}
        status={processRef.status}
        openBackgroundProcesses={props.openBackgroundProcesses}
      />
    );
  }

  const result = asBashCommandResult(props.data);
  const output = result
    ? bashResultText(result)
    : props.running && props.progress
      ? bashProgressTail(props.progress)
      : null;
  const pill = PILL[props.status];

  return (
    <div className="ema-terminal-card">
      <div className="ema-terminal-banner">
        <span className="ema-terminal-gutter-dot" style={{ background: pill.color }} aria-hidden />
        <code className="ema-terminal-cmd" title={command}>$ {command}</code>
        <span className="ema-terminal-pill" style={{ color: pill.color }}>{pill.label}</span>
        <TerminalCopyButton text={[`$ ${command}`, ...(output ? ['', output] : [])].join('\n')} />
      </div>
      {(output !== null || props.running) && (
        <div className="ema-terminal-output">
          <pre>
            {output}
            {props.running && <span className="text-[var(--ema-text-tertiary)] animate-pulse"> ▌</span>}
          </pre>
        </div>
      )}
    </div>
  );
}

/** 已转交后台的入口卡：块当场终结，卡片只给面板入口，不持续刷新。 */
function BashBackgroundCard({
  command, status, openBackgroundProcesses,
}: {
  command: string;
  status: 'queued' | 'running';
  openBackgroundProcesses(): void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 pr-6 text-[11px] bg-[var(--ema-surface-1)] border-[var(--ema-border)]">
      <span className="i-lucide:square-terminal shrink-0 text-sm text-[var(--ema-primary)]" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-[var(--ema-text-secondary)]" title={command}>
        {command}
      </span>
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">
        已转到后台{status === 'queued' ? '排队' : '运行'}
      </span>
      <button
        className="shrink-0 text-[var(--ema-primary)] hover:text-[var(--ema-primary-hover)] transition-colors"
        onClick={(event) => {
          event.stopPropagation();
          openBackgroundProcesses();
        }}
      >
        查看后台进程
      </button>
    </div>
  );
}

function TerminalCopyButton({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ema-terminal-copy"
      aria-label="复制命令与输出"
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1000);
        });
      }}
    >
      <span className={copied ? 'i-lucide:check' : 'i-lucide:copy'} aria-hidden />
    </button>
  );
}
