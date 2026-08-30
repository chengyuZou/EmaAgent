// 一次工具调用的统一行：状态、参数、进度、结果与复制。
// props 只携带真实对象——历史路径是 tool_use 块 + 索引配对的结果信封，流式路径是
// 瞬态项；专属 UI 经 tool_use.name 查表、以 TOutput（结果信封 data / 事件 output）渲染。
import { useState, useEffect, useCallback, type JSX } from 'react';
import { IconButton } from '@ema-agent/ui';
import { turnsApi } from '../../api/turns.js';
import { renderToolResult } from './toolBlocks/tool-renderers.js';
import { lookupToolUI } from './toolBlocks/toolUIRegistry.js';
import { ToolArgsView, ToolResultViewBlock } from './toolBlocks/ToolRenderBlocks.js';
import {
  defaultCopyText,
  toolVariant,
  VARIANT_ICONS,
  type ToolDisplayStatus,
} from './toolBlocks/toolBlockHelpers.js';
import { useCurrentSession } from '../state/currentSession.js';
import { useDockTabs } from '../frame/dockTabs.js';
import {
  toolArgs,
  toolDurationMs,
  toolFailure,
  toolName,
  toolOutput,
  toolPermissionPending,
  toolRowId,
  toolRunning,
  type ToolWorkRow,
} from '../history/workGroups.js';

export interface ToolCallBlockProps {
  readonly row: ToolWorkRow;
  readonly streaming?: boolean;
  /** Turn ID — 流式期间启用单工具中止按钮。 */
  readonly turnId?: string;
}

// ── 状态派生 ──────────────────────────────────────────────────────────────────

const STATUS_META: Record<ToolDisplayStatus, { color: string; label: string; pulse?: boolean }> = {
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

export function ToolCallBlock({ row, streaming = false, turnId }: ToolCallBlockProps): JSX.Element {
  const name = toolName(row);
  const args = toolArgs(row);
  const failure = toolFailure(row);
  const output = toolOutput(row);
  const partialArgs = row.source === 'stream' ? row.item.partialArgs : undefined;
  const startedAt = row.source === 'stream' ? row.item.startedAt : undefined;
  const progress = row.source === 'stream' ? row.item.progress : undefined;
  const durationMs = toolDurationMs(row);
  const permissionPending = toolPermissionPending(row);

  // 历史行缺结果信封 = Turn 中断的残留，不算运行中。
  const historyInterrupted = row.source === 'history' && row.toolResult === undefined;
  const hasResult = output !== undefined;
  const hasError = failure !== null || historyInterrupted;

  const status: ToolDisplayStatus = failure?.code === 'permission/denied'
    ? 'denied'
    : hasError
      ? 'failed'
      : permissionPending
        ? 'awaiting_permission'
        : hasResult || durationMs !== undefined
          ? 'success'
          : 'running';

  const toolUI = lookupToolUI(name);
  const [open, setOpen] = useState(() => toolUI?.defaultExpanded ?? false);
  const [copied, setCopied] = useState(false);

  const statusMeta = STATUS_META[status];
  const running = toolRunning(row, streaming);
  const argsReady = args !== undefined;
  const isPending = running && !argsReady;

  // 行头摘要由 Tool 自己的 title 钩子提供；没有注册的工具只显示工具名。
  const target = argsReady ? toolUI?.title?.(args) ?? null : null;
  const variant = toolVariant(name);
  const errorFirstLine = failure
    ? (failure.message.split('\n')[0] ?? '')
    : historyInterrupted
      ? '已中断'
      : null;

  // CallView 是组合卡（内部允许有状态子组件），按组件方式渲染；
  // ArgsView/ResultView/ProgressView 是叶子渲染器：无 hooks 纯函数，返回 null = 守卫失败回落通用渲染。
  const customArgs = toolUI?.ArgsView && argsReady ? toolUI.ArgsView({ args }) : null;
  const customResult = toolUI?.ResultView && hasResult && output != null
    ? toolUI.ResultView({ data: output })
    : null;
  const progressView = running && progress && progress.length > 0 && toolUI?.ProgressView
    ? toolUI.ProgressView({ progress })
    : null;
  const CallView = toolUI?.CallView;
  const resultView = hasResult && output !== null ? renderToolResult(output) : null;

  const viewedSessionId = useCurrentSession((s) => s.viewedSessionId);
  const openTab = useDockTabs((s) => s.openTab);

  const bodyForCopy = toolUI?.copyText?.(args, output) ?? defaultCopyText(args, output, argsReady);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(bodyForCopy).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [bodyForCopy]);

  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      {/* ── 统一工具行：leading(variant 图标/终态点) + 名 + 摘要 + 右侧状态 ── */}
      <button
        className={`ema-tool-row group ${status === 'running' ? 'ema-shimmer' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="ema-tool-row-leading" aria-hidden>
          {hasError ? (
            <span className="ema-tool-row-dot" style={{ background: 'var(--ema-danger)' }} />
          ) : status === 'awaiting_permission' ? (
            <span className="ema-tool-row-dot" style={{ background: 'var(--ema-info)' }} />
          ) : (
            <>
              <span className={`${VARIANT_ICONS[variant]} ema-tool-row-icon`} />
              <span className="i-lucide:chevron-down ema-tool-row-chevron" />
            </>
          )}
        </span>

        <span className={`font-mono text-xs shrink-0 transition-colors ${
          hasError ? 'text-[var(--ema-danger)]' : 'text-[var(--ema-text-secondary)] group-hover:text-[var(--ema-text-primary)]'
        }`}>
          {name}
        </span>

        {errorFirstLine !== null ? (
          <span className="ema-tool-row-summary text-[var(--ema-danger)]">{errorFirstLine}</span>
        ) : target ? (
          <span className="ema-tool-row-summary">{target}</span>
        ) : null}

        {/* 状态徽章 + 耗时（右侧） */}
        <span className="ml-auto flex items-center gap-1.5 text-[10px] shrink-0" style={{ color: statusMeta.color }}>
          <span
            className={`w-1.5 h-1.5 rounded-full ${statusMeta.pulse ? 'animate-pulse' : ''}`}
            style={{ background: statusMeta.color }}
            aria-hidden
          />
          {statusMeta.label}
          <StatusDuration status={status} durationMs={durationMs} startedAt={startedAt} />
        </span>

        {isPending && turnId && (
          <span className="ema-chip-in shrink-0">
            <IconButton
              label="中止该工具"
              icon="i-lucide:circle-stop"
              variant="danger"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                void turnsApi.abortTool(turnId, toolRowId(row));
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
          {CallView ? (
            <CallView
              args={args}
              {...(partialArgs !== undefined ? { partialArgs } : {})}
              {...(hasResult ? { data: output } : {})}
              {...(progress !== undefined ? { progress } : {})}
              status={status}
              running={running}
              openBackgroundProcesses={() => {
                if (viewedSessionId) {
                  openTab(viewedSessionId, { id: 'backgroundProcesses', kind: 'backgroundProcesses' });
                }
              }}
            />
          ) : (
            <>
              {/* Copy button（CallView 接管的卡片自带复制，不重复） */}
              <button
                className="absolute top-0 right-0 px-1.5 py-0.5 rounded text-[10px] transition-colors text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-2)]"
                onClick={(e) => { e.stopPropagation(); copy(); }}
              >
                {copied ? <span className="i-lucide:check text-xs" aria-hidden /> : <span className="i-lucide:copy text-xs" aria-hidden />}
              </button>

              {/* 参数区：专属 UI 优先，否则通用平铺 */}
              {argsReady ? (
                customArgs ?? <ToolArgsView args={args} />
              ) : partialArgs ? (
                <pre className="font-mono text-[11px] text-[var(--ema-text-tertiary)] whitespace-pre-wrap break-all leading-relaxed bg-transparent m-0 p-0 pr-6">
                  {partialArgs}
                </pre>
              ) : null}

              {/* 进度区：只渲染 Tool 注册的 ProgressView，没有就不建立假进度 */}
              {progressView}

              {/* 透明横线（分隔参数与结果，仅当两者都有时） */}
              {(argsReady || partialArgs) && (customResult !== null || resultView !== null) && (
                <div className="my-2 mx-4 border-t border-[var(--ema-border)]" />
              )}

              {/* 结果区：专属 UI 优先，守卫失败（null）或通用渲染 */}
              {customResult ?? (
                resultView !== null && (
                  <div className="max-h-48 overflow-auto pr-6">
                    <ToolResultViewBlock view={resultView} />
                  </div>
                )
              )}

              {/* 错误区（denied/failed 状态） */}
              {failure !== null && (
                <div className="border-l-2 pl-2 mt-1 border-[var(--ema-danger)]">
                  <pre className="font-mono text-[11px] whitespace-pre-wrap break-all bg-transparent m-0 p-0 text-[var(--ema-danger-text)]">
                    {status === 'denied' ? '已拒绝' : `[${failure.code}]`} {failure.message}
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
  status: ToolDisplayStatus;
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
