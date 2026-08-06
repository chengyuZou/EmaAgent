// 这个组件负责展示一次工具调用的状态、参数、结果和已经落盘的真实文件 diff。
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
import { IconButton } from '@ema-agent/ui';
import type { AssistantSlice } from '../../stores/conversation-store.js';
import { turnsApi } from '../../api/turns.js';
import { renderToolResult } from './toolBlocks/tool-renderers.js';
import { lookupToolUI } from './toolBlocks/toolUIRegistry.js';
import { BackgroundProcessCard } from './toolBlocks/BackgroundProcessCard.js';
import { ToolArgsView, ToolResultViewBlock, BashBlock, DiffBlock } from './toolBlocks/ToolRenderBlocks.js';
import { BASH_TOOLS, getBashCommand, buildBodyText, buildEditDiff, getPrimaryTarget, formatJson, asBashProcessReference, bashCommandOutputText } from './toolBlocks/toolBlockHelpers.js';

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
  const fileChange = slice.presentation?.kind === 'file_change' ? slice.presentation : null;
  // 后台进程引用走 data 槽(旧 presentation 通道已删);
  // 有真实结果的命令用守卫提取终端文本,不再 JSON 直出。
  const processRef = hasResult && slice.result != null ? asBashProcessReference(slice.result) : null;

  const resultView = hasResult && slice.result !== null ? renderToolResult(slice.name, slice.result) : null;
  // 专属 UI 优先;返回 null(类型守卫失败/未注册)回落通用平铺。渲染函数必须纯(无 hooks)。
  const toolUI = lookupToolUI(slice.name);
  const customArgs = toolUI?.ArgsView && argsReady ? toolUI.ArgsView({ args: slice.args }) : null;
  const customResult = toolUI?.ResultView && hasResult && slice.result != null
    ? toolUI.ResultView({ data: slice.result })
    : null;
  // 专属结果卡(权威 structuredPatch)落地后不再走旧 editDiff 通道;
  // 运行中尚无 data,仍用 args 推导的 diff 做预览。
  const editDiff = customResult !== null
    ? null
    : fileChange
      ? fileChange.unifiedDiff
      : argsReady ? buildEditDiff(slice.name, slice.args) : null;
  // bash 结果沿用原终端融合渲染（不进 renderToolResult）;转交后台的引用由卡片表达。
  const bashResultStr = isBash && hasResult && slice.result !== null && !processRef
    ? bashCommandOutputText(slice.result) ?? formatJson(slice.result)
    : null;

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
        <span className={`text-[10px] w-3 shrink-0 ${open ? 'i-lucide:chevron-down' : 'i-lucide:chevron-right'} text-[var(--ema-text-tertiary)]`} aria-hidden />

        <span className={`font-mono text-xs transition-colors ${
          hasError   ? 'text-[var(--ema-danger)]' :
          isPending  ? 'text-[var(--ema-warning)] animate-pulse' :
                       'text-[var(--ema-text-secondary)] group-hover:text-[var(--ema-text-primary)]'
        }`}>
          {slice.name}
        </span>

        {target && (
          <span className="text-xs font-mono truncate max-w-[18rem] text-[var(--ema-text-tertiary)]">
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
              icon="i-lucide:circle-stop"
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
            {copied ? <span className="i-lucide:check text-xs" aria-hidden /> : <span className="i-lucide:copy text-xs" aria-hidden />}
          </button>

          {/* Bash: 融合终端视图（命令 + 输出，不走通用平铺） */}
          {/* Bash 终端视图(转交后台后不再重复输出,由卡片表达) */}
          {isBash && !processRef && (
            <div className="max-h-64 overflow-auto pr-6">
              <BashBlock cmd={getBashCommand(slice.args) ?? ''} output={bashResultStr} partialArgs={slice.partialArgs} isPending={isPending} />
            </div>
          )}

          {/* 已转交后台的 Bash:块当场终结,卡片只给面板入口,不持续刷新。 */}
          {isBash && processRef && (
            <BackgroundProcessCard
              command={getBashCommand(slice.args) ?? ''}
              status={processRef.status}
            />
          )}

          {/* Edit diff */}
          {!isBash && editDiff && (
            <div className="max-h-64 overflow-auto pr-6">
              <DiffBlock code={editDiff} />
            </div>
          )}

          {!isBash && fileChange && !editDiff && (
            <div className="pr-6 text-[11px] text-[var(--ema-text-tertiary)]">
              {fileChange.omittedReason ?? '文件已更新，但没有可展示的文本差异。'}
            </div>
          )}

          {/* 通用工具：单块 = 参数 + 透明横线 + 结果 */}
          {!isBash && !fileChange && !editDiff && (
            <>
              {/* 参数区:专属 UI 优先,否则通用平铺 */}
              {argsReady ? (
                customArgs ?? <ToolArgsView name={slice.name} args={slice.args} />
              ) : slice.partialArgs ? (
                <pre className="font-mono text-[11px] text-[var(--ema-text-tertiary)] whitespace-pre-wrap break-all leading-relaxed bg-transparent m-0 p-0 pr-6">
                  {slice.partialArgs}
                </pre>
              ) : null}

              {/* 透明横线（分隔参数与结果，仅当两者都有时） */}
              {(argsReady || slice.partialArgs) && (customResult !== null || resultView !== null) && (
                <div className="my-2 mx-4 border-t border-[var(--ema-border)]" />
              )}

              {/* 结果区:专属 UI 优先,否则通用渲染 */}
              {customResult ?? (
                resultView !== null && (
                  <div className="max-h-48 overflow-auto pr-6">
                    <ToolResultViewBlock view={resultView} />
                  </div>
                )
              )}

              {/* 错误区（denied/failed 状态） */}
              {hasError && (
                <div className="border-l-2 pl-2 mt-1 border-[var(--ema-danger)]">
                  <pre className="font-mono text-[11px] whitespace-pre-wrap break-all bg-transparent m-0 p-0 text-[var(--ema-danger-text)]">
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
