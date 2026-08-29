// MCP Registry 来源管理:维护 Registry URL,并在来源变化后重载可安装条目.
import { useEffect, useState, type JSX } from 'react';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Spinner,
  Switch,
  Tooltip,
} from '@ema-agent/ui';
import { mcpApi, type McpRegistrySource } from '../../api/mcp.js';
import { showToast } from '../../lib/toast.js';

export function McpRegistrySourceManager({
  onSourcesChanged,
}: {
  onSourcesChanged(): Promise<void>;
}): JSX.Element {
  const [sources, setSources] = useState<McpRegistrySource[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<McpRegistrySource | null>(null);

  async function loadSources(): Promise<void> {
    setLoading(true);
    try {
      const result = await mcpApi.listSources();
      setSources([...result.items]);
    } catch (error) {
      showToast(`加载 Registry 来源失败: ${error instanceof Error ? error.message : String(error)}`, { variant: 'danger' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSources();
  }, []);

  async function updateEnabled(source: McpRegistrySource, enabled: boolean): Promise<void> {
    try {
      await mcpApi.patchSource(source.id, { enabled });
      await loadSources();
      await onSourcesChanged();
    } catch (error) {
      showToast(`更新 Registry 来源失败: ${error instanceof Error ? error.message : String(error)}`, { variant: 'danger' });
    }
  }

  async function testSource(source: McpRegistrySource): Promise<void> {
    setTestingId(source.id);
    try {
      const result = await mcpApi.testSource(source.id);
      showToast(`${source.label} 可用,共读取 ${result.sampleCount} 个条目`, { variant: 'success' });
    } catch (error) {
      showToast(`测试失败: ${error instanceof Error ? error.message : String(error)}`, { variant: 'danger' });
    } finally {
      setTestingId(null);
    }
  }

  async function removeSource(): Promise<void> {
    if (!pendingRemove) return;
    const source = pendingRemove;
    setPendingRemove(null);
    try {
      await mcpApi.removeSource(source.id);
      await loadSources();
      await onSourcesChanged();
      showToast(`已删除 Registry 来源 ${source.label}`, { variant: 'success' });
    } catch (error) {
      showToast(`删除失败: ${error instanceof Error ? error.message : String(error)}`, { variant: 'danger' });
    }
  }

  const enabledCount = sources.filter((source) => source.enabled).length;

  return (
    <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-card-decorate ema-card-decorate--circuit">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between rounded-xl px-4 py-2.5 text-left transition-colors hover:bg-[var(--ema-surface-2)]"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-[var(--ema-text-primary)]">
          <span className="i-mdi:source-branch-sync text-base text-[var(--ema-text-tertiary)]" aria-hidden />
          Registry 来源({sources.length} · 启用 {enabledCount})
        </span>
        <span
          className="i-mdi:chevron-down text-base text-[var(--ema-text-tertiary)] transition-transform"
          style={{ transform: expanded ? 'rotate(180deg)' : 'none' }}
          aria-hidden
        />
      </button>

      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }}
      >
        <div>
          <div className="flex flex-col gap-2 px-4 pb-3 pt-1">
            {loading && sources.length === 0 && <div className="flex justify-center py-3"><Spinner size="sm" /></div>}
            {!loading && sources.length === 0 && (
              <p className="py-2 text-center text-xs text-[var(--ema-text-tertiary)]">暂无 Registry 来源</p>
            )}
            {sources.map((source) => (
              <McpRegistrySourceRow
                key={source.id}
                source={source}
                testing={testingId === source.id}
                onToggle={(enabled) => void updateEnabled(source, enabled)}
                onTest={() => void testSource(source)}
                onRemove={() => setPendingRemove(source)}
              />
            ))}
            <div className="flex justify-end pt-1">
              <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)}>
                <span className="i-mdi:plus text-base" aria-hidden />
                添加来源
              </Button>
            </div>
          </div>
        </div>
      </div>

      <AddMcpRegistrySourceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={async () => {
          await loadSources();
          await onSourcesChanged();
        }}
      />
      <ConfirmDialog
        open={pendingRemove !== null}
        message={pendingRemove ? `确定删除 Registry 来源 "${pendingRemove.label}"?` : ''}
        confirmText="删除"
        onConfirm={() => void removeSource()}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}

function McpRegistrySourceRow({
  source,
  testing,
  onToggle,
  onTest,
  onRemove,
}: {
  source: McpRegistrySource;
  testing: boolean;
  onToggle(enabled: boolean): void;
  onTest(): void;
  onRemove(): void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-[var(--ema-surface-2)] px-3 py-2 ema-card-decorate ema-card-decorate--circuit">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--ema-text-primary)]">{source.label}</span>
          {source.builtin && <Badge variant="neutral">内置</Badge>}
          {!source.enabled && <Badge variant="warn">已禁用</Badge>}
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-[var(--ema-text-tertiary)] opacity-70">
          {source.registryUrl}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Tooltip content={source.enabled ? '禁用来源' : '启用来源'}>
          <Switch checked={source.enabled} label={source.label} onCheckedChange={onToggle} />
        </Tooltip>
        <Tooltip content="测试 Registry">
          <Button variant="ghost" size="sm" loading={testing} onClick={onTest}>
            <span className="i-mdi:connection text-base" aria-hidden />
          </Button>
        </Tooltip>
        {!source.builtin && (
          <Tooltip content="删除来源">
            <Button variant="ghost" size="sm" onClick={onRemove}>
              <span className="i-mdi:delete-outline text-base" aria-hidden />
            </Button>
          </Tooltip>
        )}
        {source.builtin && (
          <Tooltip content="内置来源不可删除">
            <span className="i-mdi:lock text-base text-[var(--ema-text-tertiary)] opacity-50" aria-hidden />
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function AddMcpRegistrySourceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(): Promise<void>;
}): JSX.Element {
  const [label, setLabel] = useState('');
  const [registryUrl, setRegistryUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    onOpenChange(false);
    setLabel('');
    setRegistryUrl('');
    setError(null);
  }

  async function addSource(): Promise<void> {
    setAdding(true);
    setError(null);
    try {
      await mcpApi.addSource({ label: label.trim(), registryUrl: registryUrl.trim() });
      await onCreated();
      showToast(`已添加 Registry 来源 ${label.trim()}`, { variant: 'success' });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  }

  const valid = label.trim().length > 0 && registryUrl.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) close(); }}
      title="添加 MCP Registry 来源"
      description="填写实现 MCP Registry 协议的目录地址."
      widthClass="max-w-lg"
    >
      {error && <Callout variant="danger" className="mb-3">{error}</Callout>}
      <div className="flex flex-col gap-3">
        <Field label="显示名" required>
          <Input value={label} onChange={(event) => setLabel(event.target.value)} autoFocus />
        </Field>
        <Field label="Registry URL" required>
          <Input
            value={registryUrl}
            onChange={(event) => setRegistryUrl(event.target.value)}
            placeholder="https://registry.modelcontextprotocol.io"
            className="font-mono text-xs"
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={adding} onClick={close}>取消</Button>
        <Button variant="primary" size="sm" loading={adding} disabled={!valid || adding} onClick={() => void addSource()}>
          添加
        </Button>
      </div>
    </Dialog>
  );
}
