import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Badge, Button, Callout, Dialog, EmptyState, Field, Input, MarketCard, ScrollArea, Spinner
} from '@ema-agent/ui';
import { useMcpStore } from '../../stores/mcp.js';
import type { McpMarketEntry } from '../../api/mcp.js';
import { mcpApi } from '../../api/mcp.js';
import { showToast } from '../../lib/toast.js';
import { MarketSourceManager } from '../skills/MarketSourceManager.js';

function sanitizeServerName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'mcp-server';
}

const TRANSPORT_LABEL: Record<string, string> = {
  stdio: '本地进程', http: 'Streamable HTTP',
};

function specSummary(entry: McpMarketEntry): string {
  const spec = entry.spec;
  if (!spec) return '';
  return spec.transport === 'stdio'
    ? `${spec.command} ${spec.args.join(' ')}`.trim()
    : spec.url;
}

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
  const [pendingEntry, setPendingEntry] = useState<McpMarketEntry | null>(null);
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

  async function install(entry: McpMarketEntry, inputs?: Record<string, string>): Promise<void> {
    const cleanName = sanitizeServerName(entry.title || entry.name);
    setInstalling(entry.name);
    try {
      // 安装始终由服务端从源现场取最新版本再解析;stdio 拉起走应用级批准门禁。
      await mcpApi.installFromRegistry({
        sourceId: entry.registrySourceId,
        entryName: entry.name,
        name: cleanName,
        ...(inputs ? { inputs } : {}),
      });
      await useMcpStore.getState().refresh();
      showToast(`已添加 ${cleanName}，请在「已配置」补全环境后连接`, { variant: 'success' });
    } catch (err) {
      showToast(`添加失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setInstalling(null);
    }
  }

  function handleInstall(entry: McpMarketEntry): void {
    if (!entry.installable || !entry.spec) return;
    if ((entry.requiredInputs?.length ?? 0) > 0) {
      setPendingEntry(entry);
      return;
    }
    void install(entry);
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
                key={`${entry.registrySourceId}:${entry.name}`}
                index={i}
                decorate="ema-card-decorate--circuit"
                installed={installed}
                installing={installing === entry.name}
                installDisabled={!entry.installable || !entry.spec}
                installLabel={entry.installable ? '添加' : '不可安装'}
                installedLabel="已添加"
                onInstall={() => handleInstall(entry)}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-[var(--ema-text-primary)] truncate">
                    {entry.title || entry.name}
                  </span>
                  {entry.version && <Badge variant="neutral">v{entry.version}</Badge>}
                  {entry.spec && (
                    <Badge variant="neutral">{TRANSPORT_LABEL[entry.spec.transport] ?? entry.spec.transport}</Badge>
                  )}
                  {!entry.installable && <Badge variant="warn">不可安装</Badge>}
                </div>
                {entry.description && (
                  <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 line-clamp-2">{entry.description}</p>
                )}
                {entry.unavailableReason && (
                  <p className="text-xs text-[var(--ema-warning)] mt-1">{entry.unavailableReason}</p>
                )}
                <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 font-mono truncate opacity-60">
                  {specSummary(entry)}
                </p>
              </MarketCard>
            );
          })}
        </div>
      </ScrollArea>

      <InstallInputsDialog
        entry={pendingEntry}
        busy={installing !== null}
        onCancel={() => setPendingEntry(null)}
        onConfirm={(inputs) => {
          const entry = pendingEntry;
          setPendingEntry(null);
          if (entry) void install(entry, inputs);
        }}
      />

      <Pager page={safePage} totalPages={totalPages} onChange={setPage} />
    </div>
  );
}

// ── requiredInputs 收集对话框 ──────────────────────────────────────────────────

function InstallInputsDialog({
  entry, busy, onCancel, onConfirm,
}: {
  entry:     McpMarketEntry | null;
  busy:      boolean;
  onCancel:  () => void;
  onConfirm: (inputs: Record<string, string>) => void;
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    setValues({});
  }, [entry]);

  const required = entry?.requiredInputs ?? [];
  const allFilled = required.every((input) => (values[input.key] ?? '').trim().length > 0);

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => { if (!open && !busy) onCancel(); }}
      title={`配置 ${entry?.title || entry?.name || ''}`}
      description="该服务器需要以下参数才能连接;密钥值只写入本机凭据边界。"
      widthClass="max-w-lg"
    >
      <div className="flex flex-col gap-3">
        {required.map((input) => (
          <Field
            key={input.key}
            label={`${input.key}${input.target === 'header' ? '(Header)' : '(环境变量)'}`}
            required
            description={input.description}
          >
            <Input
              type={input.isSecret ? 'password' : 'text'}
              value={values[input.key] ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [input.key]: e.target.value }))}
              className="font-mono text-xs"
              autoFocus={input === required[0]}
            />
          </Field>
        ))}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>取消</Button>
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!allFilled || busy}
          onClick={() => {
            const inputs: Record<string, string> = {};
            for (const input of required) inputs[input.key] = (values[input.key] ?? '').trim();
            onConfirm(inputs);
          }}
        >
          安装
        </Button>
      </div>
    </Dialog>
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
