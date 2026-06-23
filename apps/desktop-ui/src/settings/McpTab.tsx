import { useEffect, useState, type CSSProperties } from 'react';
import {
  Badge, Button, Callout, Card, Dialog, Divider, DropdownMenu,
  Field, Input, ScrollArea, Select, Spinner, Switch, Textarea, Tooltip,
} from '@ema-agent/ui';
import { useMcpStore, type McpServerEntry, type McpServerConfig, type McpImportResult } from '../stores/mcp-store.js';
import { showToast } from '../lib/toast.js';
import type { McpConnectionStatus } from '@ema-agent/mcp';

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

interface AddFormState {
  name:        string;
  transport:   TransportType;
  command:     string;
  args:        string;   // space-separated
  url:         string;
}

const EMPTY_FORM: AddFormState = {
  name: '', transport: 'stdio', command: '', args: '', url: '',
};

function buildConfig(form: AddFormState): McpServerConfig {
  if (form.transport === 'stdio') {
    return {
      type:    'stdio',
      command: form.command.trim(),
      args:    form.args.trim() ? form.args.trim().split(/\s+/) : [],
    };
  }
  return {
    type: form.transport as 'sse' | 'http',
    url:  form.url.trim(),
  };
}

// ── Tab component ─────────────────────────────────────────────────────────────

export function McpTab(): JSX.Element {
  const servers = useMcpStore((s) => s.servers);
  const loading = useMcpStore((s) => s.loading);
  const error   = useMcpStore((s) => s.error);

  const [addOpen,   setAddOpen]   = useState(false);
  const [form,      setForm]      = useState<AddFormState>(EMPTY_FORM);
  const [probeResult, setProbeResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [probing,   setProbing]   = useState(false);
  const [adding,    setAdding]    = useState(false);
  const [addError,  setAddError]  = useState<string | null>(null);

  const [importOpen,    setImportOpen]    = useState(false);
  const [importJson,    setImportJson]    = useState('');
  const [importing,     setImporting]     = useState(false);
  const [importError,   setImportError]   = useState<string | null>(null);
  const [importResults, setImportResults] = useState<McpImportResult[] | null>(null);

  useEffect(() => { void useMcpStore.getState().load(); }, []);

  function closeAdd(): void {
    setAddOpen(false);
    setForm(EMPTY_FORM);
    setProbeResult(null);
    setAddError(null);
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
      await useMcpStore.getState().register(form.name.trim(), buildConfig(form));
      showToast(`已注册 ${form.name}`, { variant: 'success' });
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

  async function handleRemove(name: string): Promise<void> {
    if (!confirm(`确定移除 MCP 服务器 "${name}"？`)) return;
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
            className="active:scale-[0.98] transition-all duration-250">
            <span className="i-mdi:code-json text-base" aria-hidden />
            从 JSON 导入
          </Button>
          <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}
            className="active:scale-[0.98] transition-all duration-250">
            <span className="i-mdi:plus text-base" aria-hidden />
            添加服务器
          </Button>
        </div>
      </div>

      {error && <Callout variant="danger" className="shrink-0">{error}</Callout>}

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-10">
          <Spinner size="md" />
        </div>
      )}

      {/* Empty */}
      {!loading && servers.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-[var(--ema-text-tertiary)] gap-2 ema-fade-in">
          <span className="i-mdi:server-outline text-4xl opacity-40" />
          <p className="text-sm">暂无 MCP 服务器</p>
          <p className="text-xs">点击"添加服务器"连接第一个 MCP 服务</p>
        </div>
      )}

      {/* Server list */}
      {!loading && servers.length > 0 && (
        <ScrollArea className="flex-1" viewportClassName="pb-2">
          <div className="flex flex-col gap-2 pr-2">
            {servers.map((sv, i) => (
              <div key={sv.name} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
              <ServerRow
                server={sv}
                onToggleEnabled={() => void handleToggleEnabled(sv)}
                onRemove={() => void handleRemove(sv.name)}
              />
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

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

      {/* Add-server dialog */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => { if (!open) closeAdd(); }}
        title="添加 MCP 服务器"
        description="注册一个新的 MCP 服务器。注册后自动尝试连接。"
      >
        {addError && <Callout variant="danger" className="mb-3">{addError}</Callout>}

        <div className="flex flex-col gap-3">
          <Field label="服务器名称" required>
            <Input
              placeholder="my-server"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              autoFocus
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
            </>
          ) : (
            <Field label="服务器 URL" required>
              <Input
                placeholder="http://localhost:3000/sse"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
            </Field>
          )}

          {probeResult && (
            <Callout variant={probeResult.ok ? 'success' : 'danger'}>
              {probeResult.ok ? '连接测试成功' : `连接失败：${probeResult.error}`}
            </Callout>
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
    </div>
  );
}

// ── Server row ────────────────────────────────────────────────────────────────

function ServerRow({
  server, onToggleEnabled, onRemove,
}: {
  server:           McpServerEntry;
  onToggleEnabled:  () => void;
  onRemove:         () => void;
}): JSX.Element {
  const st = STATUS_BADGE[server.connection.status];
  const toolCount = server.connection.tools.length;

  const menuItems = [
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
    <Card variant="elevated" padding="sm" className="active:scale-[0.98] transition-all duration-250">
      <div className="flex items-start gap-3">
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
              <Tooltip content={`${toolCount} 个工具可用`}>
                <Badge variant="neutral">
                  <span className="i-mdi:tools text-xs mr-1" aria-hidden />
                  {toolCount}
                </Badge>
              </Tooltip>
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
    </Card>
  );
}
