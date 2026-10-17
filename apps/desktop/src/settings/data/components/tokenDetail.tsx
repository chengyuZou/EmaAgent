// Token 明细查看器:库级 usage_records 按 Session 过滤,chips 按数据动态生成。
// KV 命中属于单次 LLM/Vision 调用，只在对应记录行按后端统一口径计算。
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { Badge, Button, Skeleton } from '@ema-agent/ui';
import { usageApi, type UsageRecordsPage } from '../../../api/usage.js';
import { subscribeSystemEvent } from '../../../lib/events/systemEventDispatcher.js';
import { fmtDateFull } from '../storageFormat.js';
import { useDetailPages } from '../useDetailPages.js';

type UsageRecord = UsageRecordsPage['items'][number];
type Capability = UsageRecord['capability'];

const PAGE_SIZE = 50;
const usageId = (record: UsageRecord): string => record.id;

export function TokenDetail({ sessionId }: { sessionId: string }): JSX.Element {
  const [chip, setChip] = useState<'all' | Capability>('all');
  const recordList = useRef<HTMLDivElement>(null);

  const readPage = useCallback(async (before: { createdAt: number; id: string } | undefined, signal: AbortSignal) => {
    const page = await usageApi.listRecords({
      sessionId,
      limit: PAGE_SIZE,
      before,
    }, signal);
    return { items: page.items, nextCursor: page.nextCursor ?? null };
  }, [sessionId]);
  const { items: records, cursor, loading, loadingMore, failed, refresh, loadMore } = useDetailPages(readPage, usageId);
  useEffect(() => {
    const unsubscribe = subscribeSystemEvent(event => {
      if (
        event.type !== 'turn_completed'
        && event.type !== 'turn_failed'
        && event.type !== 'turn_aborted'
        && event.type !== 'session_audio_changed'
      ) {
        return;
      }
      if (event.sessionId !== sessionId) {
        return;
      }
      refresh();
    });
    return unsubscribe;
  }, [sessionId, refresh]);

  useEffect(() => {
    recordList.current?.animate(
      [
        { opacity: 0.45, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 180, easing: 'ease-out' },
    );
  }, [chip]);

  // chips 跟着已加载数据长: distinct(capability) 保持 SQL 枚举顺序。
  const chips = useMemo(() => {
    const present = new Set(records.map(r => r.capability));
    return (['llm', 'vision', 'embed', 'rerank', 'stt', 'tts'] as const)
      .filter(cap => present.has(cap));
  }, [records]);

  const filtered = useMemo(
    () => (chip === 'all' ? records : records.filter(r => r.capability === chip)),
    [records, chip],
  );

  // 聚合只展示 Token 总量；不同物理调用的 KV 命中率没有合并语义。
  const tokenAggregate = useMemo(() => {
    if (chip !== 'llm' && chip !== 'vision') {
      return null;
    }
    let input = 0;
    let output = 0;
    for (const r of filtered) {
      input += r.inputTokens ?? 0;
      output += r.outputTokens ?? 0;
    }
    return { input, output };
  }, [chip, filtered]);

  if (failed && records.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-10">
        <p className="text-xs text-[var(--ema-danger)]">用量明细读取失败</p>
        <Button variant="ghost" size="sm" onClick={refresh}>重试</Button>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-8 rounded-lg" />)}
      </div>
    );
  }
  if (records.length === 0) {
    return <p className="py-10 text-center text-xs text-[var(--ema-text-tertiary)]">这个会话还没有用量记录</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {failed && (
        <div className="flex items-center gap-2 text-xs text-[var(--ema-danger)]">
          <span>刷新失败，保留已加载的用量记录</span>
          <Button variant="ghost" size="sm" onClick={refresh}>重试</Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip label="全部" active={chip === 'all'} onClick={() => setChip('all')} />
        {chips.map(cap => (
          <FilterChip
            key={cap}
            label={capabilityLabel(cap)}
            active={chip === cap}
            onClick={() => setChip(cap)}
          />
        ))}
      </div>

      {tokenAggregate && (
        <p className="text-xs text-[var(--ema-text-tertiary)]">
          已加载合计 输入 {tokenAggregate.input.toLocaleString()} Token · 输出 {tokenAggregate.output.toLocaleString()} Token
        </p>
      )}

      <div ref={recordList} className="flex flex-col">
        {records.map((record, index) => {
          const visible = chip === 'all' || record.capability === chip;
          return (
            <div
              key={record.id}
              className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
              style={{
                gridTemplateRows: visible ? '1fr' : '0fr',
                opacity: visible ? 1 : 0,
              }}
              aria-hidden={!visible}
            >
              <div className="min-h-0 overflow-hidden">
                <div
                  className={`transition-transform duration-200 ease-out ${visible
                    ? 'translate-y-0'
                    : '-translate-y-1'}`}
                >
                  <div
                    className="ema-stagger-in-swift"
                    style={{ '--stagger-i': index } as CSSProperties}
                  >
                    <UsageRow record={record} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {cursor && (
        <div className="flex justify-center py-2">
          <Button variant="ghost" size="sm" loading={loadingMore} onClick={loadMore}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, active, onClick }: {
  label: string;
  active: boolean;
  onClick(): void;
}): JSX.Element {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onClick}
      className={`border rounded-md px-2.5 py-1 text-xs transition-colors
        ${active
          ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]'
          : 'border-[var(--ema-border)] text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]'}`}
    >
      {label}
    </Button>
  );
}

const UsageRow = memo(function UsageRow({ record }: { record: UsageRecord }): JSX.Element {
  const tokenText = usageMetricText(record);
  const cacheText = usageCacheText(record);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--ema-border)] px-2 py-2 text-xs">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">
        {fmtDateFull(record.createdAt)}
      </span>
      <span className="min-w-36 flex-1 truncate font-mono text-[var(--ema-text-secondary)]" title={record.modelId}>
        {record.modelId}
      </span>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
        <span className="flex shrink-0 justify-end">
          <Badge variant="neutral">{capabilityLabel(record.capability)}</Badge>
        </span>
        <span className="text-right font-mono text-[var(--ema-text-primary)]">
          {tokenText}
          {cacheText && <span className="text-[var(--ema-text-tertiary)]"> · {cacheText}</span>}
        </span>
        <span className="shrink-0 text-right text-[var(--ema-text-tertiary)]">
          耗时 {(record.durationMs / 1_000).toFixed(1)}s
        </span>
      </div>
    </div>
  );
});

// quantity 的单位由后端记录. 调用耗时是 durationMs, 不等于输入音频或生成音频的时长.
function usageMetricText(record: UsageRecord): string {
  if (record.capability === 'tts' && record.unit === 'character') {
    return record.quantity === null ? '输入字符数未记录' : `${record.quantity.toLocaleString()} 字符`;
  }
  if (record.capability === 'stt' && record.unit === 'second') {
    return record.quantity === null ? '输入音频时长未记录' : `音频 ${record.quantity.toLocaleString()}s`;
  }
  const parts: string[] = [];
  if (record.inputTokens !== null) parts.push(`输入 ${record.inputTokens.toLocaleString()} Token`);
  if (record.outputTokens !== null) parts.push(`输出 ${record.outputTokens.toLocaleString()} Token`);
  if (record.quantity !== null && !(record.unit === 'token' && record.inputTokens !== null)) {
    parts.push(quantityText(record.quantity, record.unit));
  }
  return parts.length > 0 ? parts.join(' · ') : '输入量未记录';
}

function quantityText(quantity: number, unit: string | null): string {
  const value = quantity.toLocaleString();
  switch (unit) {
    case 'token':
      return `输入 ${value} Token`;
    case 'character':
      return `${value} 字符`;
    case 'second':
      return `音频 ${value}s`;
    case 'document':
      return `输入 ${value} 篇文档`;
    default:
      return `${value} ${unit ?? ''}`.trim();
  }
}

function capabilityLabel(capability: Capability): string {
  switch (capability) {
    case 'llm':
      return 'LLM';
    case 'embed':
      return 'Embedding';
    case 'rerank':
      return 'Rerank';
    case 'tts':
      return 'TTS';
    case 'stt':
      return 'STT';
    case 'vision':
      return 'Vision';
    default:
      return capability;
  }
}

/**
 * 后端 LLMTokenUsage 已统一为 inputTokens 包含缓存子集，因此单次调用命中率是
 * cacheReadInputTokens / inputTokens，不能再把 cacheRead 加进分母，也不能跨调用聚合。
 */
function usageCacheText(record: UsageRecord): string | null {
  if (record.capability !== 'llm' && record.capability !== 'vision') {
    return null;
  }

  const cacheRead = record.cacheReadInputTokens;
  const cacheWrite = record.cacheWriteInputTokens;
  if (cacheRead === null && cacheWrite === null) {
    return null;
  }

  const parts: string[] = [];
  if (cacheRead !== null) {
    const input = record.inputTokens ?? 0;
    const rate = input > 0 ? `${((cacheRead / input) * 100).toFixed(1)}%` : '—';
    parts.push(`KV 读缓存 ${cacheRead.toLocaleString()} · KV缓存率 ${rate}`);
  }
  if (cacheWrite !== null) parts.push(`写 ${cacheWrite.toLocaleString()}`);
  return parts.join(' · ');
}
