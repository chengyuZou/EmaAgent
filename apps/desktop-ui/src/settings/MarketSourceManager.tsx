import { useEffect, useState } from 'react';
import {
  Badge, Button, Callout, ConfirmDialog, Dialog, Field, IconButton, Input, Select, Spinner, Switch, Tooltip,
} from '@ema-agent/ui';
import {
  marketApi,
  type MarketSourceRecord,
  type MarketSourceTestResult,
  type MarketSourceTypeSchema,
} from '../api/market.js';
import { showToast } from '../lib/toast.js';

// ── MarketSourceManager(共享:MCP/Skills 两边复用,只传 kind)──────────────────
//
// 在"浏览市场"tab 顶部折叠显示源列表。builtin 源不可删只能启停;用户源可删。
// "添加源"Dialog 的 type 列表 + config 字段表单从后端 adapter.describeTypes() 动态拉
// (GET /api/market/types?kind=),后端加 type → 前端自动出表单,不再前端写死映射。

// ── 组件 ───────────────────────────────────────────────────────────────────────

export function MarketSourceManager({ kind }: { kind: 'mcp' | 'skill' }): JSX.Element {
  const [sources, setSources] = useState<MarketSourceRecord[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<MarketSourceRecord | null>(null);

  async function loadSources(): Promise<void> {
    setLoading(true);
    try {
      const { sources } = await marketApi.list(kind);
      setSources(sources);
    } catch (err) {
      showToast(`加载源失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadSources(); }, [kind]);

  async function handleToggle(source: MarketSourceRecord, enabled: boolean): Promise<void> {
    try {
      await marketApi.update(source.id, { enabled });
      setSources((prev) => prev.map((s) => (s.id === source.id ? { ...s, enabled } : s)));
    } catch (err) {
      showToast(`切换失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  function handleRemove(source: MarketSourceRecord): void {
    setPendingRemove(source);
  }

  async function confirmRemove(): Promise<void> {
    if (!pendingRemove) return;
    const source = pendingRemove;
    setPendingRemove(null);
    try {
      await marketApi.remove(source.id);
      setSources((prev) => prev.filter((s) => s.id !== source.id));
      showToast(`已删除 ${source.label}`, { variant: 'success' });
    } catch (err) {
      showToast(`删除失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  async function handleTest(source: MarketSourceRecord): Promise<void> {
    setTestingId(source.id);
    try {
      const res = await marketApi.test(source.id);
      if (res.ok) {
        showToast(`✓ ${source.label} · ${res.count ?? 0} 个条目`, { variant: 'success' });
      } else {
        showToast(`✗ ${source.label} · ${res.error ?? '测试失败'}`, { variant: 'danger' });
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
    <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-card-decorate ema-card-decorate--circuit">
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
                testing={testingId === source.id}
                onToggle={(enabled) => void handleToggle(source, enabled)}
                onRemove={() => void handleRemove(source)}
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
  source, testing, onToggle, onRemove, onTest,
}: {
  source:    MarketSourceRecord;
  testing:   boolean;
  onToggle:  (enabled: boolean) => void;
  onRemove:  () => void;
  onTest:    () => void;
}): JSX.Element {
  const configLabel = configToLabel(source);
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--ema-surface-2)] ema-card-decorate ema-card-decorate--circuit">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-[var(--ema-text-primary)] truncate">{source.label}</span>
          <Badge variant="neutral">{source.type}</Badge>
          {source.builtin && <Badge variant="neutral">内置</Badge>}
          {!source.enabled && <Badge variant="warn">已禁用</Badge>}
        </div>
        <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5 font-mono truncate opacity-70">
          {configLabel}
        </p>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <Tooltip content={source.enabled ? '禁用' : '启用'}>
          <Switch checked={source.enabled} label={source.label} onCheckedChange={onToggle} />
        </Tooltip>
        <Tooltip content="测试连通">
          <IconButton
            size="sm"
            label="测试"
            icon="i-mdi:connection"
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

/** 把 config JSON 解析成人类可读的 label(显示主要 URL/坐标)*/
function configToLabel(source: MarketSourceRecord): string {
  try {
    const cfg = JSON.parse(source.config) as Record<string, unknown>;
    if (typeof cfg['baseUrl'] === 'string') return cfg['baseUrl'];
    if (typeof cfg['indexUrl'] === 'string') return cfg['indexUrl'];
    if (typeof cfg['owner'] === 'string' && typeof cfg['repo'] === 'string') {
      return `github:${cfg['owner']}/${cfg['repo']}@${cfg['ref'] ?? 'main'}`;
    }
    return source.config;
  } catch {
    return source.config;
  }
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
  // type + 字段表单 schema 从后端 adapter.describeTypes() 动态拉,不再前端写死
  const [specs, setSpecs] = useState<MarketSourceTypeSchema[]>([]);
  const [specsLoading, setSpecsLoading] = useState(false);
  const [type, setType] = useState<string>('');
  const [label, setLabel] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<MarketSourceTestResult | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dialog 打开时拉 type schema
  useEffect(() => {
    if (!open) return;
    setSpecsLoading(true);
    marketApi.listTypes(kind)
      .then(({ types }) => {
        setSpecs(types);
        setType(types[0]?.type ?? '');
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSpecsLoading(false));
  }, [open, kind]);

  // 切 type 时重置表单
  useEffect(() => {
    setConfig({});
    setTestResult(null);
    setError(null);
  }, [type]);

  const currentSpec = specs.find((s) => s.type === type);

  function buildConfigObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const f of currentSpec?.fields ?? []) {
      const v = config[f.key]?.trim();
      if (v) obj[f.key] = v;
    }
    return obj;
  }

  function isFormValid(): boolean {
    if (!label.trim() || !type) return false;
    for (const f of currentSpec?.fields ?? []) {
      if (f.required && !config[f.key]?.trim()) return false;
    }
    return true;
  }

  async function handleTest(): Promise<void> {
    if (!isFormValid()) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await marketApi.testByConfig({
        kind,
        type,
        label: label.trim(),
        config: buildConfigObject(),
      });
      setTestResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  async function handleAdd(): Promise<void> {
    if (!isFormValid()) return;
    setAdding(true);
    setError(null);
    try {
      await marketApi.create({
        kind,
        type,
        label: label.trim(),
        config: buildConfigObject(),
      });
      showToast(`已添加源 ${label.trim()}`, { variant: 'success' });
      // 重置
      setLabel('');
      setConfig({});
      setTestResult(null);
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
    setConfig({});
    setTestResult(null);
    setError(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) close(); }}
      title={`添加${kind === 'mcp' ? ' MCP' : ' Skill'}市场源`}
      description="先测试连通再添加。镜像 URL 可选,主 URL 失败时降级。"
      widthClass="max-w-lg"
    >
      {error && <Callout variant="danger" className="mb-3">{error}</Callout>}

      <div className="flex flex-col gap-3">
        {specsLoading ? (
          <div className="flex justify-center py-4"><Spinner size="sm" /></div>
        ) : (
          <>
            <Field label="源类型" required>
              <Select
                value={type}
                onChange={(v) => setType(v)}
                options={specs.map((s) => ({ value: s.type, label: s.label }))}
              />
            </Field>

            <Field label="显示名" required>
              <Input
                placeholder="如:我的自定义源"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                autoFocus
              />
            </Field>

            {currentSpec && (
              <div className="flex flex-col gap-3 pt-1 border-t border-[var(--ema-border)]">
                <p className="text-xs text-[var(--ema-text-tertiary)] pt-2">{currentSpec.label} 配置</p>
                {currentSpec.fields.map((f) => (
                  <Field
                    key={f.key}
                    label={f.label}
                    required={f.required}
                  >
                    <Input
                      placeholder={f.placeholder}
                      value={config[f.key] ?? ''}
                      onChange={(e) => setConfig((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      className="font-mono text-xs"
                    />
                  </Field>
                ))}
              </div>
            )}
          </>
        )}

        {testResult && (
          <Callout variant={testResult.ok ? 'success' : 'danger'}>
            {testResult.ok
              ? `✓ 测试通过 · ${testResult.count ?? 0} 个条目`
              : `✗ 测试失败:${testResult.error ?? '未知错误'}`}
          </Callout>
        )}
      </div>

      <div className="flex items-center justify-between mt-4">
        <Button
          variant="secondary"
          size="sm"
          loading={testing}
          disabled={!isFormValid() || testing}
          onClick={() => void handleTest()}
        >
          测试连通
        </Button>
        <div className="flex gap-2">
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
      </div>
    </Dialog>
  );
}
