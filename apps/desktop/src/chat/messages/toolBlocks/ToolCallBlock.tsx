// 一次工具调用的统一行: 状态 参数 进度 结果与复制.
// 专属 UI 经 tool_use.name 查表 以 TOutput(结果信封 data / 事件 output)渲染.
import { useState, useEffect, type JSX, type ReactNode } from 'react';
import { IconButton } from '@ema-agent/ui';
import { sessionWebSocket } from '../../../api/sessionWebSocket.js';
import { renderToolError, renderToolResult } from './tool-renderers.js';
import { lookupToolUI } from './toolUIRegistry.js';
import { ToolArgsView, ToolResultViewBlock, ToolRows } from './ToolRenderBlocks.js';
import {
  formatJson,
  fmtDuration,
  toolVariant,
  VARIANT_ICONS,
  type ToolDisplayStatus,
} from './toolBlockHelpers.js';
import { useSessionPanelStore } from '../../../stores/sessionPanel.js';
import { useCollapsibleBody, useMessageExpansion } from '../messageExpansion.js';
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
  const showResult = hasResult && !(failure !== null && output === undefined);

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
  const [open, setOpen] = useMessageExpansion(`tool:${toolCallId(call)}`, toolUI?.defaultExpanded ?? false);
  const { containerRef, mounted } = useCollapsibleBody(open);

  const statusMeta = STATUS_META[status];
  const running = toolRunning(call, streaming);
  const argsReady = args !== undefined;

  // 行头摘要由 Tool 自己的 title 钩子读取参数. 未注册 Tool 只显示模型调用时使用的名称.
  const target = argsReady ? toolUI?.title?.(args) ?? null : null;
  const variant = toolVariant(name);

  // CallView 接管完整展开区, 供终端这类需要组合状态的工具使用.
  // ArgsView/ResultView/ProgressView 只渲染一个区域; 类型守卫失败返回 null 后使用通用视图.
  const customArgs = mounted && toolUI?.ArgsView && argsReady ? toolUI.ArgsView({ args }) : null;
  const customResult = mounted && toolUI?.ResultView && output != null
    ? toolUI.ResultView({ data: output, args })
    : null;
  const progressView = mounted && running && progress && progress.length > 0 && toolUI?.ProgressView
    ? toolUI.ProgressView({ progress })
    : null;
  // 没有类型化 data 的旧结果不能交给专属组合卡猜结构，回落通用 content 渲染。
  const CallView = fallbackContent === undefined ? toolUI?.CallView : undefined;
  const resultView = mounted && showResult && renderedOutput !== null ? renderToolResult(renderedOutput) : null;

  const openTab = useSessionPanelStore((state) => state.openTab);

  let inputCopyText = '';
  if (mounted) inputCopyText = argsReady ? formatJson(args) : partialArgs ?? '';
  const resultCopyText = mounted && showResult
    ? toolUI?.resultCopyText?.(output, args) ?? formatJson(renderedOutput)
    : '';
  const failureCopyText = failure
    ? `[${failure.code}] ${failure.message}`
    : historyInterrupted ? '未收到工具结果' : '';
  const outputCopyText = [resultCopyText, failureCopyText].filter(Boolean).join('\n\n');

  return (
    <div className={`ema-tool-card ${hasError ? 'ema-tool-card--error' : ''}`}>
      <div className="ema-tool-card-header">
        <button
          type="button"
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

          {target ? (
            <span className="ema-tool-row-summary">{target}</span>
          ) : null}

          <span className="ema-tool-row-status" style={{ color: statusMeta.color }}>
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
          <IconButton
            label="中止该工具"
            icon="i-lucide:circle-stop"
            variant="danger"
            size="sm"
            shape="rounded"
            className="ema-tool-card-icon"
            onClick={() => {
              void sessionWebSocket.cancelTool(sessionId, turnId, toolCallId(call));
            }}
          />
        )}
      </div>

      <div
        ref={containerRef}
        className="ema-collapsible ema-chat-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div>
          {mounted && (
            <div className="ema-tool-card-body">
              {CallView ? (
                <CallView
                  args={args}
                  {...(showResult ? { data: output } : {})}
                  {...(partialArgs !== undefined ? { partialArgs } : {})}
                  {...(progress !== undefined ? { progress } : {})}
                  {...(failure !== null ? { failure } : {})}
                  interrupted={historyInterrupted}
                  status={status}
                  running={running}
                  openBackgroundProcesses={() => {
                    if (sessionId) openTab(sessionId, { id: 'processes', kind: 'processes' });
                  }}
                />
              ) : (
                <div className="ema-tool-frame">
                  {(argsReady || partialArgs) && (
                    <ToolPane label="复制输入" tone="input" copyText={inputCopyText}>
                      {argsReady
                        ? customArgs ?? <ToolArgsView args={args} />
                        : <pre className="ema-tool-raw-input">{partialArgs}</pre>}
                    </ToolPane>
                  )}
                  {(progressView || customResult !== null || resultView !== null || hasError) && (
                    <ToolPane label="复制输出" tone="output" copyText={outputCopyText} errorOnly={hasError && !showResult}>
                      {progressView}
                      {customResult ?? (resultView !== null && (
                        <div className="ema-tool-generic-result"><ToolResultViewBlock view={resultView} /></div>
                      ))}
                      {failure !== null && <ToolFailure code={failure.code} message={failure.message} />}
                      {historyInterrupted && <ToolFailure code="tool/interrupted" message="未收到工具结果" />}
                    </ToolPane>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ToolPane({ label, tone, copyText, errorOnly = false, children }: {
  label: string;
  tone: 'input' | 'output';
  copyText: string;
  errorOnly?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`ema-tool-pane ema-tool-pane--${tone} ${errorOnly ? 'ema-tool-pane--error' : ''}`} aria-label={tone === 'input' ? '输入参数' : '执行结果'}>
      <div className="ema-tool-pane-content">{children}</div>
      <ToolCopyButton label={label} text={copyText} />
    </section>
  );
}

function ToolCopyButton({ label, text }: { label: string; text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? '已复制' : label}
      icon={copied ? 'i-lucide:check' : 'i-lucide:copy'}
      variant="ghost"
      size="sm"
      shape="rounded"
      className="ema-tool-card-icon"
      disabled={!text}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}

export function ToolFailure({ code, message }: { code: string; message: string }): JSX.Element {
  const rows = renderToolError(message);
  return (
    <div className="ema-tool-error" role="alert">
      <div className="ema-tool-error-code">{code}</div>
      {rows ? <ToolRows rows={rows} /> : <pre className="ema-tool-error-message">{message}</pre>}
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
