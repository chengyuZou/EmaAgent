// Token 明细查看器:库级 usage_records 按 Session 过滤,chips 按数据动态生成。
// KV 命中属于单次 LLM/Vision 调用，只在对应记录行按后端统一口径计算。
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { Badge, Button, Skeleton } from '@ema-agent/ui';
import { systemApi } from '../../api/system.js';
import { subscribeSystemEvent } from '../../lib/system-event-dispatcher.js';
import { fmtDateFull } from './storageFormat.js';

type UsageRecord = Awaited<ReturnType<typeof systemApi.getUsageRecords>>['items'][number];
type Capability = UsageRecord['capability'];

const PAGE_SIZE = 50;

export function TokenDetail({ sessionId }: { sessionId: string }): JSX.Element {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: number; id: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [chip, setChip] = useState<'all' | Capability>('all');
  const requestId = useRef(0);
  const recordList = useRef<HTMLDivElement>(null);

  const load = useCallback((before?: { createdAt: number; id: string }) => {
    const currentRequestId = ++requestId.current;
    if (before) setLoadingMore(true);
    else setLoading(true);
    systemApi.getUsageRecords({
      sessionId,
      limit: PAGE_SIZE,
      ...(before ? { before } : {}),
    }).then(result => {
      if (currentRequestId !== requestId.current) return;
      setRecords(current => before ? [...current, ...result.items] : [...result.items]);
      setCursor(result.nextCursor ?? null);
      setFailed(false);
    }).catch(() => { if (currentRequestId === requestId.current) setFailed(true); })
      .finally(() => {
        if (currentRequestId === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      });
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const unsubscribe = subscribeSystemEvent(event => {
      if (
        event.type !== 'turn_completed'
        && event.type !== 'turn_failed'
        && event.type !== 'turn_aborted'
      ) return;
      if (event.sessionId !== sessionId) return;
      load();
    });
    return unsubscribe;
  }, [sessionId, load]);

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
    if (chip !== 'llm' && chip !== 'vision') return null;
    let input = 0;
    let output = 0;
    for (const r of filtered) {
      input += r.input_tokens ?? 0;
      output += r.output_tokens ?? 0;
    }
    return { input, output };
  }, [chip, filtered]);

  if (failed) return <p className="py-10 text-center text-xs text-[var(--ema-danger)]">用量明细读取失败</p>;
  if (loading) {
    return <div className="flex flex-col gap-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-8 rounded-lg" />)}</div>;
  }
  if (records.length === 0) {
    return <p className="py-10 text-center text-xs text-[var(--ema-text-tertiary)]">这个会话还没有用量记录</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip label="全部" active={chip === 'all'} onClick={() => setChip('all')} />
        {chips.map(cap => (
          <FilterChip key={cap} label={cap} active={chip === cap} onClick={() => setChip(cap)} />
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
          <Button variant="ghost" size="sm" loading={loadingMore} onClick={() => load(cursor)}>
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
      className={`border rounded px-2.5 py-1 text-xs transition-colors 
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
    <div className="flex items-center gap-4 border-b border-[var(--ema-border)] px-2 py-1.5 text-xs">
      <span className="w-36 shrink-0 text-[var(--ema-text-tertiary)]">
        {fmtDateFull(record.created_at)}
      </span>
      <span className="w-72 shrink-0 truncate font-mono text-[var(--ema-text-secondary)]">
        {record.model_id}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-4">
        <span className="flex w-12 shrink-0 justify-end">
          <Badge variant="neutral">{record.capability}</Badge>
        </span>
        <span className="w-96 shrink-0 whitespace-nowrap text-right font-mono text-[var(--ema-text-primary)]">
          {tokenText}
          {cacheText && <span className="text-[var(--ema-text-tertiary)]"> · {cacheText}</span>}
        </span>
        <span className="w-14 shrink-0 text-right text-[var(--ema-text-tertiary)]">
          {(record.duration_ms / 1_000).toFixed(1)}s
        </span>
      </div>
    </div>
  );
});

/** 行内计量:token 类显示 ↑in ↓out，quantity 类显示数量+单位。 */
function usageMetricText(record: UsageRecord): string {
  if (record.capability === 'tts' || record.capability === 'stt') {
    return record.quantity !== null ? `${record.quantity} ${record.unit ?? ''}`.trim() : '—';
  }
  const input = record.input_tokens ?? 0;
  const output = record.output_tokens ?? 0;
  return `↑${input.toLocaleString()} ↓${output.toLocaleString()}`;
}

/**
 * 后端 LlmTokenUsage 已统一为 inputTokens 包含缓存子集，因此单次调用命中率是
 * cacheReadInputTokens / inputTokens，不能再把 cacheRead 加进分母，也不能跨调用聚合。
 */
function usageCacheText(record: UsageRecord): string | null {
  if (record.capability !== 'llm' && record.capability !== 'vision') return null;

  const cacheRead = record.cache_read_input_tokens;
  const cacheWrite = record.cache_write_input_tokens;
  if (cacheRead === null && cacheWrite === null) return null;

  const parts: string[] = [];
  if (cacheRead !== null) {
    const input = record.input_tokens ?? 0;
    const rate = input > 0 ? `${((cacheRead / input) * 100).toFixed(1)}%` : '—';
    parts.push(`KV 读缓存 ${cacheRead.toLocaleString()} · KV缓存率 ${rate}`);
  }
  if (cacheWrite !== null) parts.push(`写 ${cacheWrite.toLocaleString()}`);
  return parts.join(' · ');
}
