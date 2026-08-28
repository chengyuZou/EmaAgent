// 市场源管理（MCP/Skills 两处复用，只传 kind）："浏览市场"tab 顶部折叠显示源列表。
// builtin 源不可删只能启停；用户源可删。MCP 源 = registry URL；Skill 源 = 站点索引 URL。
import { useEffect, useState } from 'react';
import {
  Badge, Button, Callout, ConfirmDialog, Dialog, Field, IconButton, Input, Spinner, Switch, Tooltip,
} from '@ema-agent/ui';
import { mcpApi, type McpRegistrySource } from '../../api/mcp.js';
import { skillsApi, type SkillSiteRecord } from '../../api/skills.js';
import { showToast } from '../../lib/toast.js';

/** 源行直接携带原记录；两种协议都只有一种，字段分歧仅在 URL 列名。 */
type SourceRecord = McpRegistrySource | SkillSiteRecord;

function sourceUrl(source: SourceRecord): string {
  return 'registryUrl' in source ? source.registryUrl : source.indexUrl;
}

// ── 组件 ───────────────────────────────────────────────────────────────────────

export function MarketSourceManager({ kind }: { kind: 'mcp' | 'skill' }): JSX.Element {
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<SourceRecord | null>(null);

  async function loadSources(): Promise<void> {
    setLoading(true);
    try {
      if (kind === 'mcp') {
        const { items } = await mcpApi.listSources();
        setSources([...items]);
      } else {
        const { items } = await skillsApi.listSites();
        setSources([...items]);
      }
    } catch (err) {
      showToast(`加载源失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadSources(); }, [kind]);

  async function handleToggle(source: SourceRecord, enabled: boolean): Promise<void> {
    try {
      if (kind === 'mcp') {
        await mcpApi.patchSource(source.id, { enabled });
      } else {
        await skillsApi.patchSite(source.id, { enabled });
      }
      setSources((prev) => prev.map((s) => (s.id === source.id ? { ...s, enabled } : s)));
    } catch (err) {
      showToast(`切换失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  async function confirmRemove(): Promise<void> {
    if (!pendingRemove) return;
    const source = pendingRemove;
    setPendingRemove(null);
    try {
      if (kind === 'mcp') {
        await mcpApi.removeSource(source.id);
      } else {
        await skillsApi.removeSite(source.id);
      }
      setSources((prev) => prev.filter((s) => s.id !== source.id));
      showToast(`已删除 ${source.label}`, { variant: 'success' });
    } catch (err) {
      showToast(`删除失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  // MCP 有单源连通探测;Skill 只有全站刷新(各站成败独立报告),按行过滤该站结果。
  async function handleTest(source: SourceRecord): Promise<void> {
    setTestingId(source.id);
    try {
      if (kind === 'mcp') {
        // 探测失败(502)在 readRpcJson 统一抛 ServerApiError,成功类型只有 ok:true 分支。
        const res = await mcpApi.testSource(source.id);
        showToast(`✓ ${source.label} · ${res.sampleCount} 个条目`, { variant: 'success' });
      } else {
        const { items } = await skillsApi.refreshSites();
        const report = items.find((r) => r.siteId === source.id);
        if (report && report.outcome !== 'failed') {
          showToast(`✓ ${source.label} · ${report.outcome === 'updated' ? '索引已更新' : '索引已是最新'}`, { variant: 'success' });
        } else {
          showToast(`✗ ${source.label} · ${report?.error ?? '刷新失败'}`, { variant: 'danger' });
        }
      }
    } catch (err) {
      showToast(`测试失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setTestingId(null);
    }
  }

  async function handleCreated(): Promise<void> {
    await loadSources();
    setAddOpen(false);
  }

  const enabledCount = sources.filter((s) => s.enabled).length;

  return (
    <div className={`rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-card-decorate ema-card-decorate--${kind === 'skill' ? 'diamond' : 'circuit'}`}>
      {/* Header(点击展开/收起)*/}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between w-full px-4 py-2.5 text-left
                   hover:bg-[var(--ema-surface-2)] transition-colors rounded-xl"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-[var(--ema-text-primary)]">
          <span className="i-mdi:source-branch-sync text-base text-[var(--ema-text-tertiary)]" aria-hidden />
          市场源({sources.length} · 启用 {enabledCount})
        </span>
        <span className="flex items-center gap-2">
          <span
            className="i-mdi:chevron-down text-base text-[var(--ema-text-tertiary)] transition-transform"
            style={{ transform: expanded ? 'rotate(180deg)' : 'none' }}
            aria-hidden
          />
        </span>
      </button>

      {/* 折叠区(ema-collapsible 双向动画,DOM 常驻)*/}
      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }}
      >
        <div>
          <div className="px-4 pb-3 pt-1 flex flex-col gap-2">
            {loading && <div className="flex justify-center py-3"><Spinner size="sm" /></div>}

            {!loading && sources.length === 0 && (
              <p className="text-xs text-[var(--ema-text-tertiary)] py-2 text-center">
                暂无源,点右上"+ 添加源"
              </p>
            )}

            {!loading && sources.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                kind={kind}
                testing={testingId === source.id}
                onToggle={(enabled) => void handleToggle(source, enabled)}
                onRemove={() => setPendingRemove(source)}
                onTest={() => void handleTest(source)}
              />
            ))}

            <div className="flex justify-end pt-1">
              <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)}>
                <span className="i-mdi:plus text-base mr-0.5" aria-hidden />
                添加源
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* 添加源 Dialog */}
      <AddSourceDialog
        open={addOpen}
        kind={kind}
        onOpenChange={(open) => { if (!open) setAddOpen(false); }}
        onCreated={() => void handleCreated()}
      />

      <ConfirmDialog
        open={!!pendingRemove}
        message={pendingRemove ? `确定删除源"${pendingRemove.label}"?` : ''}
        confirmText="删除"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}

// ── 源行 ───────────────────────────────────────────────────────────────────────

function SourceRow({
  source, testing, onToggle, onRemove, onTest, kind,
}: {
  source:    SourceRecord;
  testing:   boolean;
  onToggle:  (enabled: boolean) => void;
  onRemove:  () => void;
  onTest:    () => void;
  kind:      'mcp' | 'skill';
}): JSX.Element {
  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--ema-surface-2)] ema-card-decorate ema-card-decorate--${kind === 'skill' ? 'diamond' : 'circuit'}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-[var(--ema-text-primary)] truncate">{source.label}</span>
          {source.builtin && <Badge variant="neutral">内置</Badge>}
          {!source.enabled && <Badge variant="warn">已禁用</Badge>}
        </div>
        <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5 font-mono truncate opacity-70">
          {sourceUrl(source)}
        </p>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <Tooltip content={source.enabled ? '禁用' : '启用'}>
          <Switch checked={source.enabled} label={source.label} onCheckedChange={onToggle} />
        </Tooltip>
        <Tooltip content={kind === 'mcp' ? '测试连通' : '刷新索引'}>
          <IconButton
            size="sm"
            label={kind === 'mcp' ? '测试' : '刷新'}
            icon={kind === 'mcp' ? 'i-mdi:connection' : 'i-mdi:refresh'}
            loading={testing}
            onClick={onTest}
          />
        </Tooltip>
        {!source.builtin && (
          <Tooltip content="删除源">
            <IconButton
              size="sm"
              label="删除"
              icon="i-mdi:delete-outline"
              onClick={onRemove}
            />
          </Tooltip>
        )}
        {source.builtin && (
          <Tooltip content="内置源不可删除">
            <span className="i-mdi:lock text-base text-[var(--ema-text-tertiary)] opacity-50" aria-hidden />
          </Tooltip>
        )}
      </div>
    </div>
  );
}

// ── 添加源 Dialog ──────────────────────────────────────────────────────────────

function AddSourceDialog({
  open, kind, onOpenChange, onCreated,
}: {
  open:        boolean;
  kind:        'mcp' | 'skill';
  onOpenChange:(open: boolean) => void;
  onCreated:   () => void;
}): JSX.Element {
  const [label, setLabel] = useState('');
  const [url, setUrl]     = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urlPlaceholder = kind === 'mcp'
    ? 'https://registry.modelcontextprotocol.io'
    : 'https://example.com/skills/index.json';

  function isFormValid(): boolean {
    return label.trim().length > 0 && url.trim().length > 0;
  }

  async function handleAdd(): Promise<void> {
    if (!isFormValid()) return;
    setAdding(true);
    setError(null);
    try {
      if (kind === 'mcp') {
        await mcpApi.addSource({ label: label.trim(), registryUrl: url.trim() });
      } else {
        await skillsApi.addSite({ label: label.trim(), indexUrl: url.trim() });
      }
      showToast(`已添加源 ${label.trim()}`, { variant: 'success' });
      setLabel('');
      setUrl('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  function close(): void {
    onOpenChange(false);
    setLabel('');
    setUrl('');
    setError(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) close(); }}
      title={`添加${kind === 'mcp' ? ' MCP' : ' Skill'}市场源`}
      description={kind === 'mcp' ? 'MCP Registry 目录源 URL。' : '技能站点索引(index.json)URL。'}
      widthClass="max-w-lg"
    >
      {error && <Callout variant="danger" className="mb-3">{error}</Callout>}

      <div className="flex flex-col gap-3">
        <Field label="显示名" required>
          <Input
            placeholder="如:我的自定义源"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label={kind === 'mcp' ? 'Registry URL' : '索引 URL'} required>
          <Input
            placeholder={urlPlaceholder}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="font-mono text-xs"
          />
        </Field>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" size="sm" onClick={close}>取消</Button>
        <Button
          variant="primary"
          size="sm"
          loading={adding}
          disabled={!isFormValid() || adding}
          onClick={() => void handleAdd()}
        >
          添加
        </Button>
      </div>
    </Dialog>
  );
}
