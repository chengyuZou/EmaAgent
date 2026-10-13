import { memo, useCallback, useEffect, useState, type JSX } from 'react';
import { Button, Skeleton } from '@ema-agent/ui';
import { turnsApi, type ToolExecutionDetail, type ToolExecutionLog } from '../../../api/turns.js';
import { ToolCallBlock } from '../../../chat/messages/toolBlocks/ToolCallBlock.js';
import { fmtDateFull } from '../storageFormat.js';
import { useDetailPages } from '../useDetailPages.js';
import { subscribeSystemEvent } from '../../../lib/events/systemEventDispatcher.js';

type Execution = ToolExecutionLog['executions'][number];
const callId = (execution: Execution): string => execution.callId;

export function ToolDetail({ turnId }: { readonly turnId: string }): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const readPage = useCallback(async (before: ToolExecutionLog['nextCursor'] | undefined, signal: AbortSignal) => {
    const page = await turnsApi.listToolExecutions(turnId, before ?? undefined, signal);
    return { items: page.executions, nextCursor: page.nextCursor };
  }, [turnId]);
  const { items, cursor, loading, loadingMore, failed, refresh, loadMore } = useDetailPages(readPage, callId);
  useEffect(() => subscribeSystemEvent(event => {
    if (
      (event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_aborted')
      && event.turnId === turnId
    ) {
      refresh();
    }
  }), [turnId, refresh]);
  const select = useCallback((id: string, open: boolean) => setOpenId(open ? id : null), []);
  return (
    <section className="flex flex-col gap-2" aria-label="工具执行目录">
      <p className="text-xs text-[var(--ema-text-tertiary)]">工具执行 · 已加载 {items.length} 条</p>
      {failed && (
        <div className="flex items-center gap-2 py-2">
          <p className="text-xs text-[var(--ema-danger)]">工具目录读取失败</p>
          <Button variant="ghost" size="sm" onClick={refresh}>
            重试
          </Button>
        </div>
      )}
      {loading ? (
        <Skeleton className="h-16 rounded-lg" />
      ) : (
        <>
          {items.length === 0 && !failed && (
            <p className="py-3 text-xs text-[var(--ema-text-tertiary)]">没有工具执行记录</p>
          )}
          {items.map(execution => (
            <ToolRow
              key={execution.callId}
              execution={execution}
              open={execution.callId === openId}
              onSelect={select}
            />
          ))}
          {cursor && (
            <Button
              variant="ghost"
              size="sm"
              loading={loadingMore}
              onClick={loadMore}
            >
              加载更多工具记录
            </Button>
          )}
        </>
      )}
    </section>
  );
}

const ToolRow = memo(function ToolRow({ execution, open, onSelect }: {
  readonly execution: Execution;
  readonly open: boolean;
  readonly onSelect: (callId: string, open: boolean) => void;
}): JSX.Element {
  const [detail, setDetail] = useState<ToolExecutionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    void turnsApi.getToolExecution(execution.turnId, execution.callId, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setDetail(result);
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setFailed(true);
      }
    }).finally(() => {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [execution.turnId, execution.callId, execution.version, open, revision]);
  const release = useCallback(() => setDetail(null), []);
  return (
    <ToolCallBlock
      call={{ source: 'execution', record: detail?.execution ?? execution, block: detail?.block, result: detail?.result }}
      expanded={open}
      onExpandedChange={next => onSelect(execution.callId, next)}
      readOnly
    >
      <ToolRecordInfo
        execution={detail?.execution ?? execution}
        loading={loading}
        failed={failed}
        missingBlocks={detail !== null && detail.block === undefined && detail.result === undefined}
        onRetry={() => setRevision(current => current + 1)}
        onRelease={release}
      />
    </ToolCallBlock>
  );
});

function ToolRecordInfo({ execution, loading, failed, missingBlocks, onRetry, onRelease }: {
  readonly execution: Execution;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly missingBlocks: boolean;
  readonly onRetry: () => void;
  readonly onRelease: () => void;
}): JSX.Element {
  // ToolCallBlock 在收起动画结束后卸载这个区域, 同时释放已经读取的长结果和 Base64.
  useEffect(() => onRelease, [onRelease]);
  return (
    <div className="flex flex-col gap-2 px-3 pb-3 pt-2 text-xs text-[var(--ema-text-tertiary)]">
      {loading && <Skeleton className="h-12 rounded-lg" />}
      {failed && (
        <div className="flex items-center gap-2">
          <p className="text-[var(--ema-danger)]">工具输入与结果读取失败</p>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            重试
          </Button>
        </div>
      )}
      {missingBlocks && <p>只有执行记录，未保存输入或结果正文。</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <span>
          开始时间 · {execution.startedAt === undefined ? '未开始' : fmtDateFull(execution.startedAt)}
        </span>
        <span>
          结束时间 · {execution.completedAt === undefined ? '未结束' : fmtDateFull(execution.completedAt)}
        </span>
      </div>
      <span className="break-all font-mono">{execution.callId}</span>
      {execution.subagentId && <span className="break-all">子代理 · {execution.subagentId}</span>}
    </div>
  );
}
