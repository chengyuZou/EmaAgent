import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Badge, Button, Callout, EmptyState, Input, MarketCard, ScrollArea, Spinner
} from '@ema-agent/ui';
import { useMcpStore, type McpServerConfig, type McpMarketEntry } from '../../stores/mcp-store.js';
import { showToast } from '../../lib/toast.js';
import { MarketSourceManager } from '../skills/MarketSourceManager.js';

function sanitizeServerName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'mcp-server';
}

const TRANSPORT_LABEL: Record<string, string> = {
  stdio: '本地进程', http: 'Streamable HTTP',
};

export function McpMarketView({
  active, installedNames,
}: {
  active:         boolean;
  installedNames: Set<string>;
}): JSX.Element {
  const marketServers = useMcpStore((s) => s.marketServers);
  const marketLoading = useMcpStore((s) => s.marketLoading);
  const marketError   = useMcpStore((s) => s.marketError);
  const marketSource  = useMcpStore((s) => s.marketSource);
  const [installing, setInstalling] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const attemptedRef = useRef(false);

  const PAGE_SIZE   = 6;
  const totalPages  = Math.max(1, Math.ceil(marketServers.length / PAGE_SIZE));
  const safePage    = Math.min(page, totalPages - 1);
  const pageServers = marketServers.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Fetch once when the tab first becomes active. A ref guard prevents the
  // retry-on-error loop (effect re-firing as loading flips false → fetch again).
  useEffect(() => {
    if (active && !attemptedRef.current) {
      attemptedRef.current = true;
      void useMcpStore.getState().listMarket();
    }
  }, [active]);

  async function handleInstall(entry: McpMarketEntry): Promise<void> {
    if (!entry.transport || !entry.installable || !entry.marketSourceId || !entry.marketSourceType) return;
    const cleanName = sanitizeServerName(entry.title || entry.name);
    const config: McpServerConfig = entry.transport === 'stdio'
      ? { type: 'stdio', command: entry.command ?? '', args: entry.args ?? [] }
      : { type: entry.transport, url: entry.url ?? '' };
    setInstalling(entry.name);
    try {
      // connect: false — many registry servers need env/keys or a local runtime;
      // save it disconnected and let the user connect from 「已配置」 afterwards.
      await useMcpStore.getState().register(
        cleanName,
        config,
        entry.websiteUrl ?? entry.repository,
        false,
        {
          sourceKind: 'market',
          marketSourceId: entry.marketSourceId,
          marketSourceType: entry.marketSourceType,
          packageRegistry: entry.packageRegistry,
          packageName: entry.packageName,
          packageVersion: entry.packageVersion,
          packageIntegrity: entry.packageIntegrity,
        },
      );
      showToast(`已添加 ${cleanName}，请在「已配置」补全环境后连接`, { variant: 'success' });
    } catch (err) {
      showToast(`添加失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setInstalling(null);
    }
  }

  if (marketLoading) {
    return <div className="flex justify-center py-12"><Spinner size="md" /></div>;
  }

  if (marketError) {
    return (
      <div className="flex flex-col gap-3">
        <Callout variant="danger">{marketError}</Callout>
        <Button variant="secondary" size="sm" className="self-start"
          onClick={() => void useMcpStore.getState().listMarket()}>
          重试
        </Button>
      </div>
    );
  }

  if (marketServers.length === 0) {
    return (
      <EmptyState icon="i-mdi:store-outline" title="市场暂无可用服务器" className="py-16" />
    );
  }

  return (
    <div className="flex flex-col min-h-0 flex-1 gap-3">
      <MarketSourceManager kind="mcp" />
      {marketSource && (
        <p className="text-xs text-[var(--ema-text-tertiary)] mb-1 font-mono truncate shrink-0">
          来源：{marketSource} · 共 {marketServers.length} 个
        </p>
      )}
      <ScrollArea className="flex-1" viewportClassName="pb-2">
        <div className="flex flex-col gap-2 pr-2">
          {pageServers.map((entry, i) => {
            const installed = installedNames.has(sanitizeServerName(entry.title || entry.name));
            return (
              <MarketCard
                key={entry.name}
                index={i}
                decorate="ema-card-decorate--circuit"
                installed={installed}
                installing={installing === entry.name}
                installDisabled={!entry.installable}
                installLabel={entry.installable ? '添加' : '不可安装'}
                installedLabel="已添加"
                onInstall={() => void handleInstall(entry)}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-[var(--ema-text-primary)] truncate">
                    {entry.title || entry.name}
                  </span>
                  {entry.version && <Badge variant="neutral">v{entry.version}</Badge>}
                  {entry.transport && (
                    <Badge variant="neutral">{TRANSPORT_LABEL[entry.transport] ?? entry.transport}</Badge>
                  )}
                  {entry.packageVersion && <Badge variant="success">已锁定包版本</Badge>}
                  {!entry.installable && <Badge variant="warn">版本未锁定</Badge>}
                </div>
                {entry.description && (
                  <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 line-clamp-2">{entry.description}</p>
                )}
                {entry.unavailableReason && (
                  <p className="text-xs text-[var(--ema-warning)] mt-1">{entry.unavailableReason}</p>
                )}
                <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 font-mono truncate opacity-60">
                  {entry.transport === 'stdio'
                    ? `${entry.command} ${entry.args?.join(' ') ?? ''}`.trim()
                    : entry.url}
                </p>
              </MarketCard>
            );
          })}
        </div>
      </ScrollArea>

      <Pager page={safePage} totalPages={totalPages} onChange={setPage} />
    </div>
  );
}

function Pager({
  page, totalPages, onChange,
}: {
  page: number; totalPages: number; onChange: (p: number) => void;
}): JSX.Element | null {
  const [jump, setJump] = useState('');
  if (totalPages <= 1) return null;

  const go = (p: number): void => onChange(Math.min(totalPages - 1, Math.max(0, p)));

  // Sliding window of up to 7 page numbers, with first/last + ellipsis.
  const WINDOW = 7;
  let start = Math.max(0, page - 3);
  const end = Math.min(totalPages, start + WINDOW);
  start = Math.max(0, end - WINDOW);
  const nums: number[] = [];
  for (let i = start; i < end; i++) nums.push(i);

  const btn = (label: ReactNode, p: number, opts: { active?: boolean; disabled?: boolean; key?: string } = {}): JSX.Element => (
    <Button
      key={opts.key ?? (typeof label === 'string' ? `${label}-${p}` : `btn-${p}`)}
      variant="ghost"
      size="sm"
      shape="rounded"
      disabled={opts.disabled}
      onClick={() => go(p)}
      className={`min-w-7 h-7 px-1.5 rounded-lg text-xs ${
        opts.active
          ? 'bg-[var(--ema-primary)] text-[var(--ema-primary-text)] border-transparent'
          : 'bg-[var(--ema-surface-2)] text-[var(--ema-text-secondary)] border-transparent hover:bg-[var(--ema-surface-3)]'
      }`}
    >
      {label}
    </Button>
  );

  return (
    <div className="flex items-center justify-center gap-1.5 flex-wrap pt-3 shrink-0">
      {btn(<span className="i-mdi:chevron-left text-xs" aria-hidden />, page - 1, { disabled: page === 0, key: 'prev' })}
      {start > 0 && (<>{btn('1', 0)}<span className="text-[var(--ema-text-tertiary)] text-xs">…</span></>)}
      {nums.map((n) => btn(String(n + 1), n, { active: n === page }))}
      {end < totalPages && (<><span className="text-[var(--ema-text-tertiary)] text-xs">…</span>{btn(String(totalPages), totalPages - 1)}</>)}
      {btn(<span className="i-mdi:chevron-right text-xs" aria-hidden />, page + 1, { disabled: page === totalPages - 1, key: 'next' })}

      <span className="text-xs text-[var(--ema-text-tertiary)] ml-1">{page + 1} / {totalPages} 页</span>
      <Input
        value={jump}
        onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))}
        onKeyDown={(e) => { if (e.key === 'Enter' && jump) { go(Number(jump) - 1); setJump(''); } }}
        placeholder="跳转"
        className="w-14 h-7 px-2 text-xs rounded-lg text-center"
      />
    </div>
  );
}