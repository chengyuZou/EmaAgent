// Skill 站点管理:维护索引来源,并把刷新结果写回 Skill Store 的唯一站点状态.
import { useState, type JSX } from 'react';
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
import type { SkillSiteRecord } from '../../api/skills.js';
import { showToast } from '../../lib/toast.js';
import { useSkillStore } from '../../stores/skill.js';

export function SkillSiteManager(): JSX.Element {
  const sites = useSkillStore((state) => state.sites);
  const loading = useSkillStore((state) => state.sitesLoading);
  const [expanded, setExpanded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<SkillSiteRecord | null>(null);

  async function refreshSites(): Promise<void> {
    setRefreshing(true);
    try {
      const result = await useSkillStore.getState().refreshSites();
      const failed = result.items.filter((item) => item.outcome === 'failed').length;
      showToast(
        failed === 0 ? '技能站点索引已刷新' : `技能站点刷新完成,${failed} 个站点失败`,
        { variant: failed === 0 ? 'success' : 'warning' },
      );
    } catch (error) {
      showToast(`刷新失败: ${error instanceof Error ? error.message : String(error)}`, { variant: 'danger' });
    } finally {
      setRefreshing(false);
    }
  }

  async function setEnabled(site: SkillSiteRecord, enabled: boolean): Promise<void> {
    try {
      await useSkillStore.getState().patchSite(site.id, { enabled });
    } catch (error) {
      showToast(`更新站点失败: ${error instanceof Error ? error.message : String(error)}`, { variant: 'danger' });
    }
  }

  async function removeSite(): Promise<void> {
    if (!pendingRemove) return;
    const site = pendingRemove;
    setPendingRemove(null);
    try {
      await useSkillStore.getState().removeSite(site.id);
      showToast(`已删除技能站点 ${site.label}`, { variant: 'success' });
    } catch (error) {
      showToast(`删除失败: ${error instanceof Error ? error.message : String(error)}`, { variant: 'danger' });
    }
  }

  const enabledCount = sites.filter((site) => site.enabled).length;

  return (
    <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-card-decorate ema-card-decorate--diamond">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between rounded-xl px-4 py-2.5 text-left transition-colors hover:bg-[var(--ema-surface-2)]"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-[var(--ema-text-primary)]">
          <span className="i-mdi:source-branch-sync text-base text-[var(--ema-text-tertiary)]" aria-hidden />
          技能站点({sites.length} · 启用 {enabledCount})
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
            {loading && sites.length === 0 && <div className="flex justify-center py-3"><Spinner size="sm" /></div>}
            {!loading && sites.length === 0 && (
              <p className="py-2 text-center text-xs text-[var(--ema-text-tertiary)]">暂无技能站点</p>
            )}
            {sites.map((site) => (
              <SkillSiteRow
                key={site.id}
                site={site}
                onToggle={(enabled) => void setEnabled(site, enabled)}
                onRemove={() => setPendingRemove(site)}
              />
            ))}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" loading={refreshing} onClick={() => void refreshSites()}>
                <span className="i-mdi:refresh text-base" aria-hidden />
                刷新全部
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)}>
                <span className="i-mdi:plus text-base" aria-hidden />
                添加站点
              </Button>
            </div>
          </div>
        </div>
      </div>

      <AddSkillSiteDialog open={addOpen} onOpenChange={setAddOpen} />
      <ConfirmDialog
        open={pendingRemove !== null}
        message={pendingRemove ? `确定删除技能站点 "${pendingRemove.label}"?` : ''}
        confirmText="删除"
        onConfirm={() => void removeSite()}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}

function SkillSiteRow({
  site,
  onToggle,
  onRemove,
}: {
  site: SkillSiteRecord;
  onToggle(enabled: boolean): void;
  onRemove(): void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-[var(--ema-surface-2)] px-3 py-2 ema-card-decorate ema-card-decorate--diamond">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--ema-text-primary)]">{site.label}</span>
          {site.builtin && <Badge variant="neutral">内置</Badge>}
          {!site.enabled && <Badge variant="warn">已禁用</Badge>}
          {site.fetchStatus === 'failed' && <Badge variant="danger">刷新失败</Badge>}
          {site.fetchStatus === 'never' && <Badge variant="neutral">尚未刷新</Badge>}
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-[var(--ema-text-tertiary)] opacity-70">
          {site.indexUrl}
        </p>
        {site.lastError && (
          <p className="mt-0.5 line-clamp-1 text-xs text-[var(--ema-danger)]">{site.lastError}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Tooltip content={site.enabled ? '禁用站点' : '启用站点'}>
          <Switch checked={site.enabled} label={site.label} onCheckedChange={onToggle} />
        </Tooltip>
        {!site.builtin && (
          <Tooltip content="删除站点">
            <Button variant="ghost" size="sm" onClick={onRemove}>
              <span className="i-mdi:delete-outline text-base" aria-hidden />
            </Button>
          </Tooltip>
        )}
        {site.builtin && (
          <Tooltip content="内置站点不可删除">
            <span className="i-mdi:lock text-base text-[var(--ema-text-tertiary)] opacity-50" aria-hidden />
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function AddSkillSiteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}): JSX.Element {
  const [label, setLabel] = useState('');
  const [indexUrl, setIndexUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    onOpenChange(false);
    setLabel('');
    setIndexUrl('');
    setError(null);
  }

  async function addSite(): Promise<void> {
    setAdding(true);
    setError(null);
    try {
      await useSkillStore.getState().addSite({ label: label.trim(), indexUrl: indexUrl.trim() });
      showToast(`已添加技能站点 ${label.trim()}`, { variant: 'success' });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  }

  const valid = label.trim().length > 0 && indexUrl.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) close(); }}
      title="添加技能站点"
      description="填写提供技能索引 index.json 的站点地址."
      widthClass="max-w-lg"
    >
      {error && <Callout variant="danger" className="mb-3">{error}</Callout>}
      <div className="flex flex-col gap-3">
        <Field label="显示名" required>
          <Input value={label} onChange={(event) => setLabel(event.target.value)} autoFocus />
        </Field>
        <Field label="索引 URL" required>
          <Input
            value={indexUrl}
            onChange={(event) => setIndexUrl(event.target.value)}
            placeholder="https://example.com/skills/index.json"
            className="font-mono text-xs"
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={adding} onClick={close}>取消</Button>
        <Button variant="primary" size="sm" loading={adding} disabled={!valid || adding} onClick={() => void addSite()}>
          添加
        </Button>
      </div>
    </Dialog>
  );
}
