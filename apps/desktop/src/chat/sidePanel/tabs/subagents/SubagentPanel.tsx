// 子代理身份入口与聊天 Header. 同一身份的全部 Run 在连续消息视口中阅读.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Button, IconButton, Spinner } from '@ema-agent/ui';
import { isStreamingMessage, useTurnStore } from '../../../../stores/turn.js';
import { subagentsApi, type SubagentListResult } from '../../../../api/subagents.js';
import { sessionWebSocket } from '../../../../api/sessionWebSocket.js';
import { useSubagentStore } from '../../../../stores/subagent.js';
import { useSessionPanelStore } from '../../../../stores/sessionPanel.js';
import { SubagentMessages } from './subagentMessages.js';

export interface SubagentPanelProps {
  sessionId: string | null;
  className?: string;
  initialDetailId?: string;
}

export function SubagentPanel({ sessionId, className = '', initialDetailId }: SubagentPanelProps): JSX.Element {
  const [detailId, setDetailId] = useState(initialDetailId ?? null);
  const [ids, setIds] = useState<readonly string[]>([]);
  const [cursor, setCursor] = useState<SubagentListResult['nextCursor']>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const records = useSubagentStore(value => value.subagents);
  const progress = useSubagentStore(value => value.progressById);
  useEffect(() => {
    setDetailId(initialDetailId ?? null);
  }, [initialDetailId]);
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setIds([]);
    setLoading(true);
    setError(null);
    void subagentsApi.list(sessionId, undefined, controller.signal).then(page => {
      if (controller.signal.aborted) {
        return;
      }
      useSubagentStore.getState().rememberSubagents(page.items);
      setIds(page.items.map(item => item.id));
      setCursor(page.nextCursor);
    }).catch(cause => {
      if (!controller.signal.aborted) {
        setError(String(cause));
      }
    }).finally(() => {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [sessionId]);
  const visibleIds = useMemo(() => {
    const all = new Set(ids);
    for (const [id, running] of progress) {
      if (running.sessionId === sessionId) {
        all.add(id);
      }
    }
    return [...all].sort((a, b) => (records.get(b)?.updatedAt ?? progress.get(b)?.startedAtMs ?? 0)
      - (records.get(a)?.updatedAt ?? progress.get(a)?.startedAtMs ?? 0)
      || b.localeCompare(a));
  }, [ids, progress, records, sessionId]);

  async function loadMore(): Promise<void> {
    if (!sessionId || !cursor || loading) {
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const page = await subagentsApi.list(sessionId, cursor, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      useSubagentStore.getState().rememberSubagents(page.items);
      setIds(current => [...new Set([...current, ...page.items.map(item => item.id)])]);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(String(cause));
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }

  if (detailId && sessionId) {
    return <SubagentDetail
      key={detailId}
      sessionId={sessionId}
      subagentId={detailId}
      className={className}
      onBack={() => {
        setDetailId(null);
        // 返回列表也清掉标签上的导航目标, 下次点同一子代理的工具卡仍能打开详情.
        useSessionPanelStore.getState().openTab(sessionId, { id: 'subagents', kind: 'subagents' });
      }}
    />;
  }
  return <div className={`ema-subagent-view ema-subagent-list ${className}`}>
    <div className="ema-subagent-heading">子智能体 <span>{visibleIds.length}</span></div>
    {visibleIds.map((id, index) => {
      const record = records.get(id);
      const running = progress.has(id);
      return <button
        type="button"
        key={id}
        className="ema-subagent-summary ema-stagger-in-swift"
        style={{ '--stagger-i': index } as React.CSSProperties}
        onClick={() => setDetailId(id)}
      >
        {running && <div className="ema-running-bar" />}
        <span className={running ? 'i-lucide:loader-circle animate-spin' : 'i-lucide:bot'} aria-hidden />
        <span className="ema-subagent-row-content">
          <strong>{record?.title ?? id}</strong>
          {record?.description && <span title={record.description}>{record.description}</span>}
        </span>
        <span className="ema-subagent-row-meta">
          <span>{running ? '运行中' : statusLabel(record?.status)}</span>
          {record && <time>{new Date(record.updatedAt).toLocaleString()}</time>}
        </span>
      </button>;
    })}
    {!loading && visibleIds.length === 0 && !error && <p className="ema-subagent-empty">当前会话没有子代理</p>}
    {error && <p className="ema-subagent-error">{error}</p>}
    {loading && <Spinner size="sm" />}
    {cursor && <Button
      variant="ghost"
      size="sm"
      disabled={loading}
      onClick={() => void loadMore()}
    >加载更多子代理</Button>}
  </div>;
}

function SubagentDetail({
  sessionId,
  subagentId,
  className,
  onBack,
}: {
  sessionId: string;
  subagentId: string;
  className: string;
  onBack(): void;
}): JSX.Element {
  const record = useSubagentStore(state => state.subagents.get(subagentId));
  const progress = useSubagentStore(state => state.progressById.get(subagentId));
  const reference = useSubagentStore(state => {
    for (const [toolCallId, ref] of state.toolReferences) {
      if (ref.subagentId === subagentId && ref.runId === progress?.runId) {
        return toolCallId;
      }
    }
    return undefined;
  });
  const foreground = useTurnStore(state => {
    for (const turn of state.turnsBySession.get(sessionId)?.values() ?? []) {
      if (turn.terminal) {
        continue;
      }
      for (const message of turn.messages) {
        if (!isStreamingMessage(message)) {
          continue;
        }
        const activeCall = message.blocks.some(block => (
          block.type === 'tool_use'
          && block.callId === reference
          && (block.status === 'running' || block.status === 'awaiting_permission')
        ));
        if (activeCall) {
          return true;
        }
      }
    }
    return false;
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void subagentsApi.get(subagentId, controller.signal)
      .then(identity => {
        if (!controller.signal.aborted) {
          useSubagentStore.getState().rememberSubagents([identity]);
        }
      })
      .catch(cause => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => controller.abort();
  }, [subagentId, progress?.runId]);

  const status = progress ? '运行中' : statusLabel(record?.status);
  const title = record?.title ?? subagentId;
  const detail = [
    subagentId,
    record?.description,
    record?.providerId,
    record?.protocol,
    record?.permissionMode,
  ].filter(Boolean).join('\n');

  return (
    <div className={`ema-subagent-detail flex min-h-0 flex-1 flex-col ${className}`}>
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--ema-border)] px-3 py-2">
        <IconButton
          label="返回子代理列表"
          icon="i-lucide:arrow-left"
          variant="ghost"
          size="sm"
          onClick={onBack}
        />
        <strong className="min-w-0 flex-1 truncate text-sm" title={detail}>
          {title}
        </strong>
        <div className="flex shrink-0 items-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
          <span>{status}</span>
          {record?.modelId && (
            <span className="max-w-40 truncate" title={record.modelId}>
              {record.modelId}
            </span>
          )}
          {record?.reasoningEffort && <span>{record.reasoningEffort}</span>}
        </div>
        {progress && !foreground && (
          <IconButton
            label="中止后台子代理"
            icon="i-lucide:circle-stop"
            variant="danger"
            size="sm"
            onClick={() => void sessionWebSocket.cancelSubagent(sessionId, subagentId)}
          />
        )}
      </header>
      {error && <p className="ema-subagent-error px-3 py-2">{error}</p>}
      <SubagentMessages subagentId={subagentId} sessionId={sessionId} />
    </div>
  );
}

function statusLabel(status?: 'running' | 'completed' | 'failed' | 'cancelled'): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已停止';
    default:
      return '读取中';
  }
}
