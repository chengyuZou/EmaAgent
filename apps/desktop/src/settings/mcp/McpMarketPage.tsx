import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Callout, Dialog, EmptyState, Field, Input, MarketCard, Spinner } from '@ema-agent/ui';
import { mcpApi, type McpMarketDetail, type McpMarketEntry } from '../../api/mcp.js';
import { MCP_MARKET_CHANGED_EVENT } from '../../lib/system-event-dispatcher.js';
import { showToast } from '../../lib/toast.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { useMcpStore } from '../../stores/mcp.js';

const SOURCE = 'official' as const;

export function McpMarketPage(): JSX.Element {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<McpMarketEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(40);
  const [pageInput, setPageInput] = useState('1');
  const [complete, setComplete] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<McpMarketDetail | null>(null);
  const requestSequence = useRef(0);
  const servers = useMcpStore(state => state.servers);
  const installed = useMemo(() => new Set(servers.flatMap(server =>
    server.provenance.sourceKind === 'official' ? [server.provenance.marketEntryId] : [])), [servers]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const loadPage = useCallback(async (nextPage: number, nextQuery: string) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = await mcpApi.market(SOURCE, nextQuery, nextPage);
      if (sequence !== requestSequence.current) return;
      setEntries(result.items);
      setTotal(result.total);
      setPage(result.page);
      setPageSize(result.pageSize);
      setPageInput(String(result.page));
      setComplete(result.complete);
      setSyncing(result.syncing);
      setError(result.refreshError ?? null);
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setError(messageOf(error));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPage(page, query); }, [loadPage, page, query]);
  useEffect(() => {
    const reload = (event: Event) => {
      if ((event as CustomEvent<string>).detail === SOURCE) void loadPage(page, query);
    };
    window.addEventListener(MCP_MARKET_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MCP_MARKET_CHANGED_EVENT, reload);
  }, [loadPage, page, query]);

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      await mcpApi.refreshMarket(SOURCE);
      await loadPage(page, query);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setRefreshing(false);
    }
  }

  function searchMarket(): void {
    const nextQuery = search.trim();
    if (page === 1 && query === nextQuery) void loadPage(1, nextQuery);
    else {
      setQuery(nextQuery);
      setPage(1);
    }
  }

  function jumpToPage(): void {
    const parsed = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setPageInput(String(page));
      return;
    }
    if (parsed > totalPages) {
      setPageInput(String(page));
      showToast(complete
        ? `市场只有 ${totalPages} 页.`
        : `第 ${parsed} 页尚未同步, 当前可查看第 1-${totalPages} 页.`, { variant: 'info' });
      return;
    }
    const nextPage = parsed;
    setPageInput(String(nextPage));
    setPage(nextPage);
  }

  async function inspect(entry: McpMarketEntry): Promise<void> {
    try {
      const detail = await mcpApi.marketDetail(entry.source, entry.externalId);
      if ('error' in detail) throw new Error('市场条目不存在.');
      if (!detail.config) throw new Error(detail.unavailableReason ?? '该条目不可安装.');
      if (detail.requiredInputs.length) setPending(detail);
      else void install(detail);
    } catch (error) {
      showToast(messageOf(error), { variant: 'danger' });
    }
  }

  async function install(entry: McpMarketDetail, inputs?: Record<string, string>): Promise<void> {
    if ('error' in entry) return;
    const key = entry.externalId;
    setInstalling(current => new Set(current).add(key));
    try {
      await mcpApi.installFromMarket(entry.source, {
        externalId: entry.externalId,
        name: serverName(entry.name),
        ...(inputs ? { inputs } : {}),
      });
      await useMcpStore.getState().refresh();
      showToast(`已添加 ${entry.name}, 正在后台连接.`, { variant: 'success' });
    } catch (error) {
      showToast(`安装失败: ${messageOf(error)}`, { variant: 'danger' });
    } finally {
      setInstalling(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <Badge variant="neutral">Official MCP Registry</Badge>
        <Button size="sm" variant="ghost" loading={refreshing} disabled={syncing} onClick={() => void refresh()}>
          <span className="i-mdi:refresh" aria-hidden />刷新
        </Button>
      </div>
      <div className="flex gap-2">
        <Input
          value={search}
          onChange={event => setSearch(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') searchMarket(); }}
          placeholder="搜索 MCP 名称或说明"
        />
        <Button size="sm" variant="secondary" onClick={searchMarket}>搜索</Button>
      </div>
      {!complete && <Callout variant="info">
        {syncing ? `市场正在后台同步, 当前已缓存 ${total} 条. 搜索结果可能不完整.` : `市场缓存尚未完整, 当前可查看 ${total} 条.`}
      </Callout>}
      {error && <Callout variant="danger">{error}</Callout>}
      {loading && entries.length === 0 ? <div className="flex justify-center py-12"><Spinner size="md" /></div>
        : entries.length === 0 ? <EmptyState icon="i-mdi:store-outline" title="暂无市场条目" hint="可以更换关键词或刷新 Official MCP Registry." />
        : <div className="grid grid-cols-1 gap-2 overflow-auto pr-2 xl:grid-cols-2">
          {entries.map((entry, index) => {
            const key = entry.externalId;
            return <MarketCard
              key={key}
              index={index}
              decorate="ema-card-decorate--circuit"
              installed={installed.has(entry.externalId)}
              installing={installing.has(key)}
              installedLabel="已添加"
              installLabel="添加"
              onInstall={() => void inspect(entry)}
            >
              <div className="flex items-center gap-2">
                <strong className="truncate text-sm">{entry.name}</strong>
                <Badge variant="neutral">Official</Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-[var(--ema-text-tertiary)]">{entry.description || '暂无说明'}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => void tauriBridge.openUrl(entry.detailUrl)}>详情</Button>
                {entry.repositoryUrl && <Button size="sm" variant="ghost" onClick={() => void tauriBridge.openUrl(entry.repositoryUrl!)}>源码</Button>}
              </div>
            </MarketCard>;
          })}
        </div>}
      {!loading && total > 0 && <div className="flex items-center justify-between gap-3 text-xs text-[var(--ema-text-tertiary)]">
        <span>{complete ? `共 ${total} 条` : `已缓存 ${total} 条`}</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(current => current - 1)}>上一页</Button>
          <span>第</span>
          <Input
            className="w-16 text-center"
            value={pageInput}
            inputMode="numeric"
            onChange={event => setPageInput(event.target.value)}
            onBlur={jumpToPage}
            onKeyDown={event => { if (event.key === 'Enter') jumpToPage(); }}
            aria-label="页码"
          />
          <span>{complete ? `/ ${totalPages} 页` : `/ 当前可用 ${totalPages} 页`}</span>
          <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => setPage(current => current + 1)}>下一页</Button>
        </div>
      </div>}
      <InstallDialog detail={pending} busy={pending && !('error' in pending) ? installing.has(pending.externalId) : false} onCancel={() => setPending(null)} onInstall={inputs => {
        const detail = pending;
        setPending(null);
        if (detail) void install(detail, inputs);
      }} />
    </div>
  );
}

function InstallDialog({ detail, busy, onCancel, onInstall }: {
  detail: McpMarketDetail | null;
  busy: boolean;
  onCancel(): void;
  onInstall(inputs: Record<string, string>): void;
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const required = detail && !('error' in detail) ? detail.requiredInputs : [];
  return <Dialog open={detail !== null} onOpenChange={open => { if (!open && !busy) onCancel(); }} title={`配置 ${detail && !('error' in detail) ? detail.name : ''}`}>
    <div className="flex flex-col gap-3">{required.map(input => <Field key={input.key} label={input.key} required description={input.description}>
      <Input type={input.secret ? 'password' : 'text'} value={values[input.key] ?? ''} onChange={event => setValues(current => ({ ...current, [input.key]: event.target.value }))} />
    </Field>)}</div>
    <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={onCancel}>取消</Button><Button variant="primary" disabled={required.some(input => !values[input.key]?.trim())} onClick={() => onInstall(values)}>安装</Button></div>
  </Dialog>;
}

function serverName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'mcp-server';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
