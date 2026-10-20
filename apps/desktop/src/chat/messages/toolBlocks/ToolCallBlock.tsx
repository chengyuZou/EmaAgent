import { useState, useEffect, useMemo, useRef, type JSX, type ReactNode, type Ref } from 'react';
import { CodeViewer, IconButton, Tooltip } from '@ema-agent/ui';
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
  /** 存储目录由外层控制单条展开, Chat 省略时沿用消息的展开状态. */
  readonly expanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly readOnly?: boolean;
  /** 所在页面提供的读取状态与记录时间, 和结果区一起收起. */
  readonly children?: ReactNode;
}

const STATUS_META: Record<ToolDisplayStatus, { color: string; label: string; pulse?: boolean }> = {
  running:             { color: 'var(--ema-warning-text)', label: '运行中', pulse: true },
  awaiting_permission: { color: 'var(--ema-info-text)',    label: '等待确认', pulse: true },
  success:             { color: 'var(--ema-success-text)', label: '成功' },
  failed:              { color: 'var(--ema-danger-text)',  label: '失败' },
  denied:              { color: 'var(--ema-danger-text)',  label: '已拒绝' },
};

export function ToolCallBlock({
  call, streaming = false, turnId, sessionId, expanded, onExpandedChange, readOnly = false, children,
}: ToolCallBlockProps): JSX.Element {
  const name = toolName(call);
  const args = toolArgs(call);
  const failure = toolFailure(call);
  const output = toolOutput(call);
  const fallbackContent = toolFallbackContent(call);
  const renderedOutput = output ?? fallbackContent;
  const partialArgs = call.source === 'streaming' ? call.item.partialArgs : undefined;
  let startedAt: number | undefined;
  if (call.source === 'streaming') startedAt = call.item.startedAt;
  if (call.source === 'execution') startedAt = call.record.startedAt;
  const progress = call.source === 'streaming' ? call.item.progress : undefined;
  const durationMs = toolDurationMs(call);
  const permissionPending = toolPermissionPending(call);

  // History 缺结果信封表示应用退出或 Turn 中断时没有拿到工具终态. 它不能恢复成运行中.
  const historyInterrupted = call.source === 'history' && call.result === undefined;
  const historyCompleted = call.source === 'history' && call.result !== undefined;
  const hasResult = renderedOutput !== undefined;
  const executionFailed = call.source === 'execution'
    && (call.record.status === 'failed' || call.record.status === 'cancelled' || call.record.status === 'outcome_unknown');
  const hasError = failure !== null || historyInterrupted || executionFailed;
  const showResult = hasResult && !(failure !== null && output === undefined);

  let status: ToolDisplayStatus;
  if (failure?.code === 'permission/denied') {
    status = 'denied';
  } else if (hasError) {
    status = 'failed';
  } else if (permissionPending) {
    status = 'awaiting_permission';
  } else if (call.source === 'execution') {
    status = call.record.status === 'succeeded' ? 'success' : 'running';
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
  const [outputToolbarContainer, setOutputToolbarContainer] = useState<HTMLDivElement | null>(null);
  const [messageOpen, setMessageOpen] = useMessageExpansion(`tool:${toolCallId(call)}`, toolUI?.defaultExpanded ?? false);
  const open = expanded ?? messageOpen;
  const { containerRef, mounted } = useCollapsibleBody(open);

  const statusMeta = STATUS_META[status];
  const customStatusLabel = toolUI?.statusLabel?.(status);
  let statusLabel = customStatusLabel === undefined ? statusMeta.label : customStatusLabel;
  if (call.source === 'execution') {
    switch (call.record.status) {
      case 'prepared':
        statusLabel = '准备中';
        break;
      case 'authorized':
        statusLabel = '待执行';
        break;
      case 'cancelled':
        statusLabel = '已取消';
        break;
      case 'outcome_unknown':
        statusLabel = '结果未确认';
        break;
    }
  }
  const running = toolRunning(call, streaming);
  const argsReady = args !== undefined;

  // 行头摘要由 Tool 自己的 title 钩子读取参数. 未注册 Tool 只显示模型调用时使用的名称.
  const target = argsReady ? toolUI?.title?.(args) ?? null : null;
  const variant = toolVariant(name);

  // CallView 接管完整展开区, 供终端这类需要组合状态的工具使用.
  // ArgsView/ResultView/ProgressView 只渲染一个区域; 类型守卫失败返回 null 后使用通用视图.
  const customArgs = mounted && toolUI?.ArgsView && argsReady ? toolUI.ArgsView({ args }) : null;
  const customResult = mounted && toolUI?.ResultView && output != null
    ? toolUI.ResultView({ data: output, args, toolbarContainer: outputToolbarContainer })
    : null;
  const progressView = mounted && running && progress && progress.length > 0 && toolUI?.ProgressView
    ? toolUI.ProgressView({ progress })
    : null;
  // 没有类型化 data 的结果不能交给专属组合卡猜结构, 回落通用 content 渲染.
  const CallView = fallbackContent === undefined && (call.source !== 'execution' || argsReady || hasResult)
    ? toolUI?.CallView
    : undefined;
  const needsGenericResult = mounted && showResult && !CallView && customResult === null;
  const resultView = useMemo(() => (
    needsGenericResult ? renderToolResult(renderedOutput) : null
  ), [needsGenericResult, renderedOutput]);

  const openTab = useSessionPanelStore((state) => state.openTab);

  const inputCopyText = useMemo(() => {
    if (!mounted || CallView) return '';
    return argsReady ? formatJson(args) : partialArgs ?? '';
  }, [mounted, CallView, argsReady, args, partialArgs]);
  const resultCopyText = useMemo(() => {
    if (!mounted || !showResult || CallView) return '';
    return toolUI?.resultCopyText?.(output, args) ?? resultView?.source ?? formatJson(renderedOutput);
  }, [mounted, showResult, CallView, toolUI, output, args, resultView, renderedOutput]);
  const failureCopyText = failure
    ? `[${failure.code}] ${failure.message}`
    : historyInterrupted ? '未收到工具结果' : '';
  const outputCopyText = [resultCopyText, failureCopyText].filter(Boolean).join('\n\n');

  return (
    <div className={`ema-tool-card ${hasError ? 'ema-tool-card--error' : ''}`}>
      <div className={`ema-tool-card-header ${status === 'running' ? 'ema-shimmer' : ''}`}>
        <button
          type="button"
          className="ema-tool-row group min-w-0 flex-1"
          onClick={() => {
            if (onExpandedChange) onExpandedChange(!open);
            else setMessageOpen(value => !value);
          }}
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
            {statusLabel !== null && (
              <>
                <span
                  className={`w-1.5 h-1.5 rounded-full ${statusMeta.pulse ? 'animate-pulse' : ''}`}
                  style={{ background: statusMeta.color }}
                  aria-hidden
                />
                {statusLabel}
              </>
            )}
            <span className="text-[var(--ema-text-tertiary)] tabular-nums">
              <StatusDuration status={status} durationMs={durationMs} startedAt={startedAt} separated={statusLabel !== null} />
            </span>
          </span>
        </button>
        {!readOnly && running && turnId && sessionId && (
          <IconButton
            label="中止该工具"
            iconNode={<span className="ema-tool-stop-square" />}
            variant="ghost"
            size="sm"
            shape="rounded"
            className="ema-tool-card-icon ema-tool-stop"
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
                  openBackgroundProcesses={readOnly || !sessionId ? undefined : () => {
                    openTab(sessionId, { id: 'processes', kind: 'processes' });
                  }}
                />
              ) : (
                <div className="ema-tool-frame">
                  {(argsReady || partialArgs) && (
                    <ToolPane label="复制输入" tone="input" copyText={inputCopyText}>
                      {argsReady
                        ? customArgs ?? <ToolArgsView source={inputCopyText} />
                        : <CodeViewer source={partialArgs ?? ''} embedded />}
                    </ToolPane>
                  )}
                  {(progressView || customResult !== null || resultView !== null || hasError) && (
                    <ToolPane
                      label="复制输出" tone="output" copyText={outputCopyText}
                      summary={showResult ? toolUI?.resultSummary?.(output) : undefined}
                      errorOnly={hasError && !showResult}
                      actionsRef={setOutputToolbarContainer}
                    >
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
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ToolPane({ label, tone, copyText, summary, errorOnly = false, actionsRef, children }: {
  label: string;
  tone: 'input' | 'output';
  copyText: string;
  summary?: string | null;
  errorOnly?: boolean;
  actionsRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`ema-tool-pane ema-tool-pane--${tone} ${errorOnly ? 'ema-tool-pane--error' : ''}`} aria-label={tone === 'input' ? '输入参数' : '执行结果'}>
      <div className="ema-tool-pane-toolbar">
        <span className="min-w-0">
          {tone === 'input' ? '输入' : '输出'}
          {summary && <span className="ml-2 text-[var(--ema-text-secondary)]">{summary}</span>}
        </span>
        <div className="ema-tool-pane-actions">
          {actionsRef && <div ref={actionsRef} className="ema-tool-pane-actions" />}
          <ToolCopyButton label={label} text={copyText} />
        </div>
      </div>
      <div className="ema-tool-pane-content">{children}</div>
    </section>
  );
}

function ToolCopyButton({ label, text }: { label: string; text: string }): JSX.Element {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    setCopyStatus('idle');
    return () => clearTimeout(timer.current);
  }, [text]);
  let tooltip = label;
  if (copyStatus === 'copied') tooltip = '已复制';
  if (copyStatus === 'failed') tooltip = '复制失败，请重试';
  return (
    <Tooltip content={tooltip}>
      <IconButton
        label={tooltip}
        icon={copyStatus === 'copied' ? 'i-lucide:check' : 'i-lucide:copy'}
        variant="ghost"
        size="sm"
        shape="rounded"
        className="ema-tool-card-icon"
        disabled={!text}
        onClick={(event) => {
          event.stopPropagation();
          clearTimeout(timer.current);
          void navigator.clipboard.writeText(text).then(() => {
            setCopyStatus('copied');
          }).catch(() => {
            setCopyStatus('failed');
          }).finally(() => {
            timer.current = setTimeout(() => setCopyStatus('idle'), 1500);
          });
        }}
      />
    </Tooltip>
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



function StatusDuration({
  status, durationMs, startedAt, separated,
}: {
  status: ToolDisplayStatus;
  durationMs?: number;
  startedAt?: number;
  separated: boolean;
}): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== 'running' || !startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [status, startedAt]);

  if (status === 'running' && startedAt) {
    return <span className="tabular-nums">{separated ? '· ' : ''}{fmtDuration(now - startedAt)}</span>;
  }
  if (durationMs != null && (status === 'success' || status === 'failed' || status === 'denied')) {
    return <span className="tabular-nums">{separated ? '· ' : ''}{fmtDuration(durationMs)}</span>;
  }
  // 等待授权时暂停显示计时; 已结束但没有 durationMs 时不猜测耗时.
  return null;
}
