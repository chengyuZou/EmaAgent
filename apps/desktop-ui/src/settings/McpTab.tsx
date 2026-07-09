import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Badge, Button, Callout, Card, ConfirmDialog, Dialog, Divider, DropdownMenu,
  Field, IconButton, Input, ScrollArea, Select, Spinner, Switch, Tabs, Textarea, Tooltip,
} from '@ema-agent/ui';
import { useMcpStore, type McpServerEntry, type McpServerConfig, type McpProbeResult, type McpImportResult, type McpMarketEntry } from '../stores/mcp-store.js';
import { showToast } from '../lib/toast.js';
import type { McpConnectionStatus } from '@ema-agent/mcp';
import { MarketSourceManager } from './MarketSourceManager.js';

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<McpConnectionStatus, { variant: 'success' | 'warn' | 'danger' | 'neutral'; label: string }> = {
  connected:    { variant: 'success', label: '已连接' },
  connecting:   { variant: 'warn',    label: '连接中' },
  failed:       { variant: 'danger',  label: '连接失败' },
  disconnected: { variant: 'neutral', label: '未连接' },
};

type TransportType = 'stdio' | 'sse' | 'http';

const TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'Stdio(本地进程)' },
  { value: 'sse',   label: 'SSE(远程 HTTP)'  },
  { value: 'http',  label: 'Streamable HTTP'  },
];

// ── Add-server form state ─────────────────────────────────────────────────────

interface KvPair { key: string; value: string }

interface AddFormState {
  name:        string;
  transport:   TransportType;
  command:     string;
  args:        string;   // space-separated
  url:         string;
  /** Environment variables for stdio (API keys etc., e.g. AMAP_MAPS_API_KEY). */
  env:         KvPair[];
  /** Request headers for sse/http (auth, e.g. Authorization: Bearer …). */
  headers:     KvPair[];
}

const EMPTY_FORM: AddFormState = {
  name: '', transport: 'stdio', command: '', args: '', url: '', env: [], headers: [],
};

function kvToRecord(pairs: KvPair[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    if (key.trim()) out[key.trim()] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function recordToKv(rec: Record<string, string> | undefined): KvPair[] {
  return rec ? Object.entries(rec).map(([key, value]) => ({ key, value })) : [];
}

function buildConfig(form: AddFormState): McpServerConfig {
  if (form.transport === 'stdio') {
    return {
      type:    'stdio',
      command: form.command.trim(),
      args:    form.args.trim() ? form.args.trim().split(/\s+/) : [],
      env:     kvToRecord(form.env),
    };
  }
  return {
    type:    form.transport as 'sse' | 'http',
    url:     form.url.trim(),
    headers: kvToRecord(form.headers),
  };
}

/** Pre-fill the form from an existing server (edit flow). */
function configToForm(name: string, config: McpServerConfig): AddFormState {
  if (config.type === 'stdio') {
    return {
      name, transport: 'stdio',
      command: config.command,
      args:    (config.args ?? []).join(' '),
      url:     '',
      env:     recordToKv(config.env),
      headers: [],
    };
  }
  return {
    name, transport: config.type,
    command: '', args: '',
    url:     config.url,
    env:     [],
    headers: recordToKv(config.headers),
  };
}

// ── Key-value editor (env vars / headers) ──────────────────────────────────────

function KeyValueEditor({
  pairs, onChange, keyPlaceholder, valuePlaceholder, secret,
}: {
  pairs:             KvPair[];
  onChange:          (pairs: KvPair[]) => void;
  keyPlaceholder?:   string;
  valuePlaceholder?: string;
  secret?:           boolean;
}): JSX.Element {
  const [reveal, setReveal] = useState(false);
  const update = (i: number, patch: Partial<KvPair>): void =>
    onChange(pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  return (
    <div className="flex flex-col gap-1.5">
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            inputSize="sm" className="flex-1 font-mono" placeholder={keyPlaceholder}
            value={p.key} onChange={(e) => update(i, { key: e.target.value })}
          />
          <Input
            inputSize="sm" className="flex-1 font-mono"
            type={secret && !reveal ? 'password' : 'text'} placeholder={valuePlaceholder}
            value={p.value} onChange={(e) => update(i, { value: e.target.value })}
          />
          <IconButton
            size="sm" label="删除" icon="i-mdi:close"
            onClick={() => onChange(pairs.filter((_, idx) => idx !== i))}
          />
        </div>
      ))}
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => onChange([...pairs, { key: '', value: '' }])}>
          <span className="i-mdi:plus text-base mr-0.5" aria-hidden /> 添加一项
        </Button>
        {secret && pairs.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setReveal((v) => !v)}>
            {reveal ? '隐藏值' : '显示值'}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Tab component ─────────────────────────────────────────────────────────────

export function McpTab(): JSX.Element {
  const servers = useMcpStore((s) => s.servers);
  const loading = useMcpStore((s) => s.loading);
  const error   = useMcpStore((s) => s.error);

  const [addOpen,   setAddOpen]   = useState(false);
  const [form,      setForm]      = useState<AddFormState>(EMPTY_FORM);
  const [probeResult, setProbeResult] = useState<McpProbeResult | null>(null);
  const [probing,   setProbing]   = useState(false);
  const [adding,    setAdding]    = useState(false);
  const [addError,  setAddError]  = useState<string | null>(null);

  const [importOpen,    setImportOpen]    = useState(false);
  const [importJson,    setImportJson]    = useState('');
  const [importing,     setImporting]     = useState(false);
  const [importError,   setImportError]   = useState<string | null>(null);
  const [importResults, setImportResults] = useState<McpImportResult[] | null>(null);

  const [activeTab, setActiveTab] = useState('installed');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  useEffect(() => { void useMcpStore.getState().load(); }, []);

  const installedNames = new Set(servers.map((s) => s.name));

  function closeAdd(): void {
    setAddOpen(false);
    setForm(EMPTY_FORM);
    setProbeResult(null);
    setAddError(null);
    setEditingName(null);
  }

  function handleEdit(sv: McpServerEntry): void {
    setForm(configToForm(sv.name, sv.config));
    setEditingName(sv.name);
    setProbeResult(null);
    setAddError(null);
    setAddOpen(true);
  }

  async function handleProbe(): Promise<void> {
    setProbing(true);
    setProbeResult(null);
    try {
      const result = await useMcpStore.getState().probe(buildConfig(form));
      setProbeResult(result);
    } catch (err) {
      setProbeResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setProbing(false);
    }
  }

  async function handleAdd(): Promise<void> {
    if (!form.name.trim()) { setAddError('名称不能为空'); return; }
    setAdding(true);
    setAddError(null);
    try {
      // register() upserts by name; editing re-registers + connects so the new
      // env/headers (API keys, Bearer token) take effect immediately.
      await useMcpStore.getState().register(form.name.trim(), buildConfig(form), undefined, true);
      showToast(editingName ? `已更新 ${form.name}` : `已注册 ${form.name}`, { variant: 'success' });
      closeAdd();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  function closeImport(): void {
    setImportOpen(false);
    setImportJson('');
    setImportError(null);
    setImportResults(null);
  }

  async function handleImport(): Promise<void> {
    const trimmed = importJson.trim();
    if (!trimmed) return;
    let payload: object;
    try {
      payload = JSON.parse(trimmed) as object;
    } catch {
      setImportError('JSON 格式错误，请检查后重试');
      return;
    }
    setImporting(true);
    setImportError(null);
    setImportResults(null);
    try {
      const results = await useMcpStore.getState().importFromJson(payload);
      setImportResults(results);
      const ok    = results.filter((r) => r.ok).length;
      const total = results.length;
      showToast(`已导入 ${ok}/${total} 个服务器`, { variant: ok > 0 ? 'success' : 'warning' });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function handleToggleEnabled(sv: McpServerEntry): Promise<void> {
    try {
      if (sv.enabled) {
        await useMcpStore.getState().disable(sv.name);
      } else {
        await useMcpStore.getState().enable(sv.name);
      }
    } catch (err) {
      showToast(`操作失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  function handleRemove(name: string): void {
    setPendingRemove(name);
  }

  async function confirmRemove(): Promise<void> {
    if (!pendingRemove) return;
    const name = pendingRemove;
    setPendingRemove(null);
    try {
      await useMcpStore.getState().remove(name);
      showToast(`已移除 ${name}`, { variant: 'success' });
    } catch (err) {
      showToast(`移除失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  const formValid = form.name.trim() &&
    (form.transport === 'stdio' ? form.command.trim() : form.url.trim());

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">MCP 服务器</h2>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">连接模型上下文协议(MCP)服务器，扩展 Agent 的工具集</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}
            className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)]">
            <span className="i-mdi:code-json text-base" aria-hidden />
            从 JSON 导入
          </Button>
          <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}
            className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)]">
            <span className="i-mdi:plus text-base" aria-hidden />
            添加服务器
          </Button>
        </div>
      </div>

      {error && <Callout variant="danger" className="shrink-0">{error}</Callout>}

      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        variant="underline"
        items={[
          {
            value: 'installed',
            label: `已配置 (${servers.length})`,
            content: (
              <>
                {loading && (
                  <div className="flex justify-center py-10"><Spinner size="md" /></div>
                )}
                {!loading && servers.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-16 text-[var(--ema-text-tertiary)] gap-2 ema-fade-in">
                    <span className="i-mdi:server-outline text-4xl opacity-40" />
                    <p className="text-sm">暂无 MCP 服务器</p>
                    <p className="text-xs">点击"添加服务器"或到「浏览市场」挑选</p>
                  </div>
                )}
                {!loading && servers.length > 0 && (
                  <ScrollArea className="flex-1" viewportClassName="pb-2">
                    <div className="flex flex-col gap-2 pr-2">
                      {servers.map((sv, i) => (
                        <div key={sv.name} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
                          <ServerRow
                            server={sv}
                            onToggleEnabled={() => void handleToggleEnabled(sv)}
                            onRemove={() => void handleRemove(sv.name)}
                            onEdit={() => handleEdit(sv)}
                          />
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </>
            ),
          },
          {
            value: 'market',
            label: '浏览市场',
            content: <McpMarketView active={activeTab === 'market'} installedNames={installedNames} />,
          },
        ]}
      />

      {/* Import from JSON dialog */}
      <Dialog
        open={importOpen}
        onOpenChange={(open) => { if (!open) closeImport(); }}
        title="从 JSON 导入 MCP 服务器"
        description="粘贴 Claude Desktop 或 mcp.so 格式的 JSON 配置，支持批量导入多个服务器。"
        widthClass="max-w-2xl"
      >
        {importError && <Callout variant="danger" className="mb-3">{importError}</Callout>}

        {importResults ? (
          <div className="flex flex-col gap-2">
            {importResults.map((r, i) => (
              <div
                key={r.name}
                className="flex items-start gap-3 px-3 py-2 rounded-lg
                           border border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-stagger-in"
                style={{ '--stagger-i': i } as CSSProperties}
              >
                <Badge variant={r.ok ? 'success' : 'danger'} dot className="mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--ema-text-primary)]">{r.name}</span>
                    <Badge variant={r.ok ? 'success' : 'danger'}>{r.ok ? '成功' : '失败'}</Badge>
                  </div>
                  {r.error && (
                    <p className="text-xs text-[var(--ema-danger)] mt-0.5">{r.error}</p>
                  )}
                  {r.connectError && (
                    <p className="text-xs text-[var(--ema-warning)] mt-0.5">连接警告：{r.connectError}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Field label="JSON 配置" required description='格式：{ "mcpServers": { "服务器名": { "command": "...", "args": [...] } } }'>
            <Textarea
              minRows={8}
              maxRows={16}
              placeholder={'{\n  "mcpServers": {\n    "brave-search": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-brave-search"]\n    }\n  }\n}'}
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
              className="font-mono text-xs"
            />
          </Field>
        )}

        <div className="flex justify-end gap-2 mt-4">
          {importResults ? (
            <Button variant="primary" size="sm" onClick={closeImport}>完成</Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={closeImport}>取消</Button>
              <Button
                variant="primary"
                size="sm"
                loading={importing}
                disabled={!importJson.trim() || importing}
                onClick={() => void handleImport()}
              >导入</Button>
            </>
          )}
        </div>
      </Dialog>

      {/* Add / edit-server dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => { if (!open) closeAdd(); }}
        title={editingName ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
        description="注册后自动尝试连接。远程服务器在 Headers 填鉴权，本地进程在环境变量填 API Key。"
        widthClass="max-w-lg"
      >
        {addError && <Callout variant="danger" className="mb-3">{addError}</Callout>}

        <div className="flex flex-col gap-3">
          <Field label="服务器名称" required>
            <Input
              placeholder="my-server"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              disabled={!!editingName}
              autoFocus={!editingName}
            />
          </Field>

          <Field label="传输类型" required>
            <Select
              value={form.transport}
              onChange={(v) => setForm({ ...form, transport: v as TransportType })}
              options={TRANSPORT_OPTIONS}
            />
          </Field>

          {form.transport === 'stdio' ? (
            <>
              <Field label="可执行文件" required>
                <Input
                  placeholder="uvx / npx / /path/to/binary"
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                />
              </Field>
              <Field label="参数" description="以空格分隔">
                <Input
                  placeholder="mcp-server-brave-search --port 8080"
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                />
              </Field>
              <Field label="环境变量" description="API Key 等，如 AMAP_MAPS_API_KEY">
                <KeyValueEditor
                  pairs={form.env}
                  onChange={(env) => setForm({ ...form, env })}
                  keyPlaceholder="AMAP_MAPS_API_KEY"
                  valuePlaceholder="api_key"
                  secret
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="服务器 URL" required>
                <Input
                  placeholder="http://localhost:3000/sse"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                />
              </Field>
              <Field label="请求头 Headers" description="鉴权等，如 Authorization: Bearer …">
                <KeyValueEditor
                  pairs={form.headers}
                  onChange={(headers) => setForm({ ...form, headers })}
                  keyPlaceholder="Authorization"
                  valuePlaceholder="Bearer sk-..."
                  secret
                />
              </Field>
            </>
          )}

          {probeResult && (
            <Callout variant={probeResult.ok ? 'success' : 'danger'}>
              {probeResult.ok ? '连接测试成功' : `连接失败：${probeResult.error}`}
            </Callout>
          )}

          {probeResult?.ok && probeResult.tools && probeResult.tools.length > 0 && (
            <div className="flex flex-col gap-1.5 mt-2 ema-fade-in">
              <span className="text-xs" style={{ color: 'var(--ema-text-tertiary)' }}>
                发现 {probeResult.tools.length} 个工具：
              </span>
              {probeResult.tools.map((t) => {
                const params = toolParamNames(t.inputSchema);
                return (
                  <div key={t.serverToolName} className="rounded-lg px-2.5 py-1.5 bg-[var(--ema-surface-1)] border border-[var(--ema-border)]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono font-medium text-[var(--ema-text-primary)]">{t.serverToolName}</span>
                      {params.length > 0 && (
                        <span className="text-[10px] text-[var(--ema-text-tertiary)] font-mono">({params.join(', ')})</span>
                      )}
                    </div>
                    {t.description && (
                      <p className="text-[11px] text-[var(--ema-text-tertiary)] mt-0.5 line-clamp-2">{t.description}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <Divider className="my-4" />

        <div className="flex items-center justify-between">
          <Button
            variant="secondary"
            size="sm"
            loading={probing}
            disabled={!formValid || probing}
            onClick={() => void handleProbe()}
          >测试连接</Button>

          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={closeAdd}>取消</Button>
            <Button
              variant="primary"
              size="sm"
              loading={adding}
              disabled={!formValid || adding}
              onClick={() => void handleAdd()}
            >添加</Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!pendingRemove}
        message={pendingRemove ? `确定移除 MCP 服务器 "${pendingRemove}"？` : ''}
        confirmText="移除"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}

// ── Market view ───────────────────────────────────────────────────────────────

function sanitizeServerName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'mcp-server';
}

const TRANSPORT_LABEL: Record<string, string> = {
  stdio: '本地进程', sse: 'SSE 远程', http: 'HTTP 远程',
};

function McpMarketView({
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
    if (!entry.transport) return;
    const cleanName = sanitizeServerName(entry.title || entry.name);
    const config: McpServerConfig = entry.transport === 'stdio'
      ? { type: 'stdio', command: entry.command ?? '', args: entry.args ?? [] }
      : { type: entry.transport, url: entry.url ?? '' };
    setInstalling(entry.name);
    try {
      // connect: false — many registry servers need env/keys or a local runtime;
      // save it disconnected and let the user connect from 「已配置」 afterwards.
      await useMcpStore.getState().register(cleanName, config, entry.websiteUrl ?? entry.repository, false);
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
      <div className="flex flex-col items-center justify-center py-16 text-[var(--ema-text-tertiary)] gap-2">
        <span className="i-mdi:store-outline text-4xl opacity-40" aria-hidden />
        <p className="text-sm">市场暂无可用服务器</p>
      </div>
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
              <div
                key={entry.name}
                className="bg-[var(--ema-surface-1)] ema-glass-weak border border-[var(--ema-border)]
                           rounded-xl px-4 py-3 ema-stagger-in"
                style={{ '--stagger-i': i } as CSSProperties}
              >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-[var(--ema-text-primary)] truncate">
                      {entry.title || entry.name}
                    </span>
                    {entry.version && <Badge variant="neutral">v{entry.version}</Badge>}
                    {entry.transport && (
                      <Badge variant="neutral">{TRANSPORT_LABEL[entry.transport] ?? entry.transport}</Badge>
                    )}
                  </div>
                  {entry.description && (
                    <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 line-clamp-2">{entry.description}</p>
                  )}
                  <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 font-mono truncate opacity-60">
                    {entry.transport === 'stdio'
                      ? `${entry.command} ${entry.args?.join(' ') ?? ''}`.trim()
                      : entry.url}
                  </p>
                </div>

                <div className="shrink-0 pt-0.5">
                  {installed ? (
                    <Badge variant="success">已添加</Badge>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={installing === entry.name}
                      disabled={installing !== null}
                      onClick={() => void handleInstall(entry)}
                    >
                      添加
                    </Button>
                  )}
                </div>
              </div>
            </div>
            );
          })}
        </div>
      </ScrollArea>

      <Pager page={safePage} totalPages={totalPages} onChange={setPage} />
    </div>
  );
}

// ── Pager (numbered pages + prev/next + jump-to-page) ─────────────────────────

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

  const btn = (label: string, p: number, opts: { active?: boolean; disabled?: boolean } = {}): JSX.Element => (
    <button
      key={`${label}-${p}`}
      disabled={opts.disabled}
      onClick={() => go(p)}
      className={`min-w-7 h-7 px-1.5 rounded-lg text-xs transition-colors disabled:opacity-30 ${
        opts.active
          ? 'bg-[var(--ema-primary)] text-[var(--ema-primary-text)] font-medium'
          : 'bg-[var(--ema-surface-2)] text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-3)]'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex items-center justify-center gap-1.5 flex-wrap pt-3 shrink-0">
      {btn('‹', page - 1, { disabled: page === 0 })}
      {start > 0 && (<>{btn('1', 0)}<span className="text-[var(--ema-text-tertiary)] text-xs">…</span></>)}
      {nums.map((n) => btn(String(n + 1), n, { active: n === page }))}
      {end < totalPages && (<><span className="text-[var(--ema-text-tertiary)] text-xs">…</span>{btn(String(totalPages), totalPages - 1)}</>)}
      {btn('›', page + 1, { disabled: page === totalPages - 1 })}

      <span className="text-xs text-[var(--ema-text-tertiary)] ml-1">{page + 1} / {totalPages} 页</span>
      <input
        value={jump}
        onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))}
        onKeyDown={(e) => { if (e.key === 'Enter' && jump) { go(Number(jump) - 1); setJump(''); } }}
        placeholder="跳转"
        className="w-14 h-7 px-2 text-xs rounded-lg text-center outline-none
                   bg-[var(--ema-surface-1)] border border-[var(--ema-border)]
                   text-[var(--ema-text-primary)] placeholder:text-[var(--ema-text-tertiary)]
                   focus:border-[var(--ema-primary)]"
      />
    </div>
  );
}

// ── Server row ────────────────────────────────────────────────────────────────

function toolParamNames(schema: Record<string, unknown> | undefined): string[] {
  const props = schema && (schema as { properties?: unknown }).properties;
  return props && typeof props === 'object' ? Object.keys(props as object) : [];
}

function ServerRow({
  server, onToggleEnabled, onRemove, onEdit,
}: {
  server:           McpServerEntry;
  onToggleEnabled:  () => void;
  onRemove:         () => void;
  onEdit:           () => void;
}): JSX.Element {
  const st = STATUS_BADGE[server.connection.status];
  const tools = server.connection.tools;
  const toolCount = tools.length;
  const [expanded, setExpanded]     = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const menuItems = [
    {
      kind: 'item' as const,
      label: '编辑 / 鉴权',
      icon: 'i-mdi:pencil-outline',
      onSelect: onEdit,
    },
    {
      kind: 'item' as const,
      label: '详情 / 参数',
      icon: 'i-mdi:information-outline',
      onSelect: () => setDetailOpen(true),
    },
    { kind: 'separator' as const },
    server.connection.status === 'connected'
      ? {
          kind: 'item' as const,
          label: '断开连接',
          icon: 'i-mdi:lan-disconnect',
          onSelect: () => void useMcpStore.getState().disconnect(server.name)
            .catch((err: Error) => showToast(`断开失败: ${err.message}`, { variant: 'danger' })),
        }
      : {
          kind: 'item' as const,
          label: '重新连接',
          icon: 'i-mdi:lan-connect',
          onSelect: () => void useMcpStore.getState().connect(server.name)
            .then(() => showToast(`${server.name} 已连接`, { variant: 'success' }))
            .catch((err: Error) => showToast(`连接失败: ${err.message}`, { variant: 'danger' })),
        },
    { kind: 'separator' as const },
    {
      kind: 'item' as const,
      label: '移除服务器',
      icon: 'i-mdi:delete-outline',
      danger: true,
      onSelect: onRemove,
    },
  ];

  return (
    <Card variant="elevated" padding="sm" className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)]">
      <div className="group flex items-start gap-3">
        {/* Status dot */}
        <div className="pt-0.5 shrink-0">
          <Badge variant={st.variant} dot />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-[var(--ema-text-primary)]">{server.name}</span>
            <Badge variant={st.variant}>{st.label}</Badge>
            {toolCount > 0 && (
              <button
                className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs
                           bg-[var(--ema-surface-2)] text-[var(--ema-text-secondary)]
                           hover:bg-[var(--ema-surface-3)] transition-colors"
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? '收起工具' : '展开查看工具'}
              >
                <span className="i-mdi:tools text-xs" aria-hidden />
                {toolCount}
                <span className={`i-mdi:chevron-down text-xs transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />
              </button>
            )}
          </div>

          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5 font-mono">
            {server.config.type === 'stdio'
              ? `${server.config.command} ${server.config.args?.join(' ') ?? ''}`.trim()
              : (server.config as { url: string }).url}
          </p>

          {server.connection.status === 'failed' && (
            <p className="text-xs text-[var(--ema-danger)] mt-1 line-clamp-1">
              连接错误
            </p>
          )}

          {/* Inline expanded tool list — quick glance at names + params */}
          {expanded && toolCount > 0 && (
            <div className="mt-2 flex flex-col gap-1.5 ema-slide-up">
              {tools.map((t) => {
                const params = toolParamNames(t.inputSchema);
                return (
                  <div key={t.serverToolName} className="rounded-lg px-2.5 py-1.5 bg-[var(--ema-surface-1)] border border-[var(--ema-border)]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono font-medium text-[var(--ema-text-primary)]">{t.serverToolName}</span>
                      {params.length > 0 && (
                        <span className="text-[10px] text-[var(--ema-text-tertiary)] font-mono">({params.join(', ')})</span>
                      )}
                    </div>
                    {t.description && (
                      <p className="text-[11px] text-[var(--ema-text-tertiary)] mt-0.5 line-clamp-2">{t.description}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          <Tooltip content={server.enabled ? '禁用(下次启动不自动连接)' : '启用'}>
            <Switch
              checked={server.enabled}
              label={server.name}
              onCheckedChange={onToggleEnabled}
            />
          </Tooltip>
          {/* DropdownMenu hover 显隐(抄 session 列表 opacity-0 group-hover:opacity-100) */}
          <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            <DropdownMenu
              trigger={
                <Button variant="ghost" size="sm" className="px-1.5">
                  <span className="i-mdi:dots-vertical text-base text-[var(--ema-text-tertiary)]" aria-hidden />
                </Button>
              }
              items={menuItems}
              align="end"
            />
          </div>
        </div>
      </div>

      {/* Detail dialog — full config + every tool's parameter schema */}
      <Dialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        title={`${server.name} · 详情`}
        description="连接配置与工具参数 schema"
        widthClass="max-w-2xl"
      >
        <div className="flex flex-col gap-4 max-h-[65vh] overflow-auto">
          {/* Config */}
          <div>
            <p className="text-xs font-medium text-[var(--ema-text-secondary)] mb-1">连接配置</p>
            <pre className="text-xs font-mono whitespace-pre-wrap break-words rounded-lg p-2.5
                            bg-[var(--ema-surface-0)] text-[var(--ema-text-secondary)] border border-[var(--ema-border)] selectable">
              {JSON.stringify(server.config, null, 2)}
            </pre>
          </div>

          {/* Tools */}
          <div>
            <p className="text-xs font-medium text-[var(--ema-text-secondary)] mb-1">
              工具 ({toolCount})
            </p>
            {toolCount === 0 ? (
              <p className="text-xs text-[var(--ema-text-tertiary)]">未连接或无工具（连接后才能读取）</p>
            ) : (
              <div className="flex flex-col gap-2">
                {tools.map((t) => (
                  <div key={t.serverToolName} className="rounded-lg p-2.5 bg-[var(--ema-surface-1)] border border-[var(--ema-border)]">
                    <span className="text-xs font-mono font-medium text-[var(--ema-text-primary)]">{t.serverToolName}</span>
                    {t.description && (
                      <p className="text-[11px] text-[var(--ema-text-tertiary)] mt-0.5">{t.description}</p>
                    )}
                    <pre className="text-[11px] font-mono whitespace-pre-wrap break-words mt-1.5 rounded p-2
                                    bg-[var(--ema-surface-0)] text-[var(--ema-text-tertiary)] border border-[var(--ema-border)] selectable">
                      {JSON.stringify(t.inputSchema ?? {}, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
