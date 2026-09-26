// 一次工具调用的统一行: 状态 参数 进度 结果与复制.
// 专属 UI 经 tool_use.name 查表 以 TOutput(结果信封 data / 事件 output)渲染.
import { useState, useEffect, useCallback, type JSX } from 'react';
import { IconButton } from '@ema-agent/ui';
import { sessionWebSocket } from '../../../api/sessionWebSocket.js';
import { renderToolResult } from './tool-renderers.js';
import { lookupToolUI } from './toolUIRegistry.js';
import { ToolArgsView, ToolResultViewBlock } from './ToolRenderBlocks.js';
import {
  defaultCopyText,
  fmtDuration,
  toolVariant,
  VARIANT_ICONS,
  type ToolDisplayStatus,
} from './toolBlockHelpers.js';
import { useSessionPanelStore } from '../../../stores/sessionPanel.js';
import {
  toolArgs,
  toolDurationMs,
  toolFallbackContent,
  toolFailure,
  toolName,
  toolOutput,
  toolPermissionPending,
  toolCallId,
  toolRunning,
  type ToolDisplayCall,
} from './toolGroups.js';

export interface ToolCallBlockProps {
  /** History 的 tool_use + ToolResult, 或 Turn Stream 中同一次调用的实时状态. */
  readonly call: ToolDisplayCall;
  /** 仅表示所属 Turn 仍在执行, 具体工具是否运行以 call.item.status 为准. */
  readonly streaming?: boolean;
  /** Turn ID. 流式期间中止按钮把 toolCallId 和 turnId 一起发给 Server. */
  readonly turnId?: string;
  /** 取消请求必须发给这一条消息所属 Session, 不从当前页面导航状态猜测. */
  readonly sessionId?: string;
}

const STATUS_META: Record<ToolDisplayStatus, { color: string; label: string; pulse?: boolean }> = {
  running:             { color: 'var(--ema-warning-text)', label: '运行中', pulse: true },
  awaiting_permission: { color: 'var(--ema-info-text)',    label: '等待确认', pulse: true },
  success:             { color: 'var(--ema-success-text)', label: '成功' },
  failed:              { color: 'var(--ema-danger-text)',  label: '失败' },
  denied:              { color: 'var(--ema-danger-text)',  label: '已拒绝' },
};

export function ToolCallBlock({ call, streaming = false, turnId, sessionId }: ToolCallBlockProps): JSX.Element {
  const name = toolName(call);
  const args = toolArgs(call);
  const failure = toolFailure(call);
  const output = toolOutput(call);
  const fallbackContent = toolFallbackContent(call);
  const renderedOutput = output ?? fallbackContent;
  const partialArgs = call.source === 'streaming' ? call.item.partialArgs : undefined;
  const startedAt = call.source === 'streaming' ? call.item.startedAt : undefined;
  const progress = call.source === 'streaming' ? call.item.progress : undefined;
  const durationMs = toolDurationMs(call);
  const permissionPending = toolPermissionPending(call);

  // History 缺结果信封表示应用退出或 Turn 中断时没有拿到工具终态. 它不能恢复成运行中.
  const historyInterrupted = call.source === 'history' && call.result === undefined;
  const historyCompleted = call.source === 'history' && call.result !== undefined;
  const hasResult = renderedOutput !== undefined;
  const hasError = failure !== null || historyInterrupted;

  let status: ToolDisplayStatus;
  if (failure?.code === 'permission/denied') {
    status = 'denied';
  } else if (hasError) {
    status = 'failed';
  } else if (permissionPending) {
    status = 'awaiting_permission';
  } else if (call.source === 'streaming') {
    if (call.item.status === 'succeeded') {
      status = 'success';
    } else if (
      call.item.status === 'failed'
      || call.item.status === 'interrupted'
      || call.item.status === 'outcome_unknown'
    ) {
      status = 'failed';
    } else {
      status = 'running';
    }
  } else {
    status = historyCompleted ? 'success' : 'running';
  }

  const toolUI = lookupToolUI(name);
  const [open, setOpen] = useState(() => toolUI?.defaultExpanded ?? false);
  const [copied, setCopied] = useState(false);

  const statusMeta = STATUS_META[status];
  const running = toolRunning(call, streaming);
  const argsReady = args !== undefined;

  // 行头摘要由 Tool 自己的 title 钩子读取参数. 未注册 Tool 只显示模型调用时使用的名称.
  const target = argsReady ? toolUI?.title?.(args) ?? null : null;
  const variant = toolVariant(name);
  const errorFirstLine = failure
    ? (failure.message.split('\n')[0] ?? '')
    : historyInterrupted
      ? '已中断'
      : null;

  // CallView 接管完整展开区, 供终端这类需要组合状态的工具使用.
  // ArgsView/ResultView/ProgressView 只渲染一个区域; 类型守卫失败返回 null 后使用通用视图.
  const customArgs = toolUI?.ArgsView && argsReady ? toolUI.ArgsView({ args }) : null;
  const customResult = toolUI?.ResultView && output != null
    ? toolUI.ResultView({ data: output, args })
    : null;
  const progressView = running && progress && progress.length > 0 && toolUI?.ProgressView
    ? toolUI.ProgressView({ progress })
    : null;
  // 没有类型化 data 的旧结果不能交给专属组合卡猜结构，回落通用 content 渲染。
  const CallView = fallbackContent === undefined ? toolUI?.CallView : undefined;
  const resultView = hasResult && renderedOutput !== null ? renderToolResult(renderedOutput) : null;

  const openTab = useSessionPanelStore((state) => state.openTab);

  const bodyForCopy = toolUI?.copyText?.(args, output) ?? defaultCopyText(args, renderedOutput, argsReady);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(bodyForCopy).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [bodyForCopy]);

  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      {/* ── 统一工具行：leading(variant 图标/终态点) + 名 + 摘要 + 右侧状态 ── */}
      <div className="flex items-center gap-1">
        <button
          className={`ema-tool-row group min-w-0 flex-1 ${status === 'running' ? 'ema-shimmer' : ''}`}
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

          {/* 状态徽章 + 耗时（右侧）: 点+label 染状态色, 耗时是元数据归三级灰。 */}
          <span className="ml-auto flex items-center gap-1.5 text-[10px] shrink-0" style={{ color: statusMeta.color }}>
            <span
              className={`w-1.5 h-1.5 rounded-full ${statusMeta.pulse ? 'animate-pulse' : ''}`}
              style={{ background: statusMeta.color }}
              aria-hidden
            />
            {statusMeta.label}
            <span className="text-[var(--ema-text-tertiary)] tabular-nums">
              <StatusDuration status={status} durationMs={durationMs} startedAt={startedAt} />
            </span>
          </span>
        </button>
        {running && turnId && sessionId && (
          <span className="ema-chip-in shrink-0">
            <IconButton
              label="中止该工具"
              icon="i-lucide:circle-stop"
              variant="danger"
              size="sm"
              onClick={() => {
                void sessionWebSocket.cancelTool(sessionId, turnId, toolCallId(call));
              }}
            />
          </span>
        )}
      </div>

      {/* ── Expanded body — grid-rows trick for smooth height animation ── */}
      <div
        className="ema-collapsible ema-chat-collapsible"
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
                if (sessionId) {
                  openTab(sessionId, { id: 'processes', kind: 'processes' });
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
