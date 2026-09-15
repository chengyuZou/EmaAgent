// Token 明细查看器:库级 usage_records 按 Session 过滤,chips 按数据动态生成
// (无 producer 的能力不出现,未来接上自动长出);全部档纯 SQL 原样,LLM/Vision 档带 KV 缓存率。
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { Badge, Button, Skeleton } from '@ema-agent/ui';
import { systemApi } from '../../api/system.js';
import { subscribeSystemEvent } from '../../lib/system-event-dispatcher.js';
import { fmtDateFull } from './storageFormat.js';

type UsageRecord = Awaited<ReturnType<typeof systemApi.getUsageRecords>>['items'][number];
type Capability = UsageRecord['capability'];

const PAGE_SIZE = 500;

export function TokenDetail({ sessionId }: { sessionId: string }): JSX.Element {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: number; id: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [chip, setChip] = useState<'all' | Capability>('all');
  const requestId = useRef(0);

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
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type !== 'usage_recorded' || event.sessionId !== sessionId) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => load(), 150);
    });
    return () => { unsubscribe(); clearTimeout(refreshTimer); };
  }, [sessionId, load]);

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

  // LLM/Vision 档的聚合:token 合计 + KV 缓存率。
  // 公式按 Anthropic 口径(input_tokens=非缓存输入):cache_read/(cache_read+input);
  // 目前库中尚无含缓存字段的真实记录,口径待有数据后复核。
  const llmAggregate = useMemo(() => {
    if (chip !== 'llm' && chip !== 'vision') return null;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    for (const r of filtered) {
      input += r.input_tokens ?? 0;
      output += r.output_tokens ?? 0;
      cacheRead += r.cache_read_input_tokens ?? 0;
    }
    const rateBase = cacheRead + input;
    return {
      input,
      output,
      cacheRate: rateBase > 0 ? cacheRead / rateBase : null,
    };
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

      {llmAggregate && (
        <p className="text-xs text-[var(--ema-text-tertiary)]">
          合计 ↑ {llmAggregate.input.toLocaleString()} · ↓ {llmAggregate.output.toLocaleString()}
          {llmAggregate.cacheRate !== null && ` · KV 缓存率 ${(llmAggregate.cacheRate * 100).toFixed(1)}%`}
        </p>
      )}

      {/* key=chip:切过滤条件整体重挂,行按新集重放滑入。 */}
      <div key={chip} className="flex flex-col divide-y divide-[var(--ema-border)]">
        {filtered.map((record, index) => (
          <div
            key={record.id}
            className="ema-stagger-in-swift"
            style={{ '--stagger-i': index } as CSSProperties}
          >
            <UsageRow record={record} />
          </div>
        ))}
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
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs transition-colors
        ${active
          ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]'
          : 'border-[var(--ema-border)] text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]'}`}
    >
      {label}
    </button>
  );
}

function UsageRow({ record }: { record: UsageRecord }): JSX.Element {
  const tokenText = usageMetricText(record);
  return (
    <div className="flex items-center gap-3 px-2 py-1.5 text-xs">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">{fmtDateFull(record.created_at)}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[var(--ema-text-secondary)]">
        {record.model_id}
      </span>
      <Badge variant="neutral">{record.capability}</Badge>
      <span className="shrink-0 font-mono text-[var(--ema-text-primary)]">{tokenText}</span>
      <span className="w-14 shrink-0 text-right text-[var(--ema-text-tertiary)]">
        {(record.duration_ms / 1_000).toFixed(1)}s
      </span>
    </div>
  );
}

/** 行内计量:token 类显示 ↑in ↓out(含缓存读),quantity 类显示数量+单位。 */
function usageMetricText(record: UsageRecord): string {
  if (record.capability === 'tts' || record.capability === 'stt') {
    return record.quantity !== null ? `${record.quantity} ${record.unit ?? ''}`.trim() : '—';
  }
  const input = record.input_tokens ?? 0;
  const output = record.output_tokens ?? 0;
  const cacheRead = record.cache_read_input_tokens;
  const base = `↑${input.toLocaleString()} ↓${output.toLocaleString()}`;
  return cacheRead ? `${base} 缓存${cacheRead.toLocaleString()}` : base;
}
