// 技能市场视图:站点源管理、按站点缓存索引浏览条目与安装(版本对账以索引为事实源)。
import { useEffect, useRef, useState, type JSX } from 'react';
import { Badge, Button, Callout, EmptyState, MarketCard, Spinner } from '@ema-agent/ui';
import { useSkillStore, type SkillSiteRecord } from '../../stores/skill-store.js';
import { showToast } from '../../lib/toast.js';
import { MarketSourceManager } from './MarketSourceManager.js';
import { formatBytes } from './skillFormat.js';

type SiteEntry = NonNullable<SkillSiteRecord['index']>['skills'][number];

interface MarketRow {
  siteId:    string;
  siteLabel: string;
  entry:     SiteEntry;
}

export function SkillMarketView({ active }: { active: boolean }): JSX.Element {
  const sites        = useSkillStore((s) => s.sites);
  const sitesLoading = useSkillStore((s) => s.sitesLoading);
  const sitesError   = useSkillStore((s) => s.sitesError);
  const skills       = useSkillStore((s) => s.skills);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const attemptedRef = useRef(false);

  // 首开激活时拉站点清单;索引是站点缓存,未刷新过的站点由用户手动刷新。
  useEffect(() => {
    if (active && !attemptedRef.current) {
      attemptedRef.current = true;
      void useSkillStore.getState().loadSites();
    }
  }, [active]);

  // 已安装判定:站点安装的技能带 provenance(siteId+siteEntryId),与索引条目逐项对账。
  const installedKeys = new Set(
    skills.flatMap((sk) =>
      sk.provenance?.kind === 'site'
        ? [`${sk.provenance.siteId}:${sk.provenance.siteEntryId}`]
        : [],
    ),
  );

  const rows: MarketRow[] = sites
    .filter((site) => site.enabled && site.index !== null)
    .flatMap((site) =>
      (site.index?.skills ?? []).map((entry) => ({
        siteId: site.id,
        siteLabel: site.label,
        entry,
      })),
    );

  async function handleRefresh(): Promise<void> {
    setRefreshing(true);
    try {
      await useSkillStore.getState().refreshSites();
      showToast('站点索引已刷新', { variant: 'success' });
    } catch (err) {
      showToast(`刷新失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleInstall(row: MarketRow): Promise<void> {
    const key = `${row.siteId}:${row.entry.id}`;
    setInstalling((prev) => new Set(prev).add(key));
    try {
      const result = await useSkillStore.getState().installFromSite(row.siteId, row.entry.id);
      showToast(`已安装 ${result.name}`, { variant: 'success' });
    } catch (err) {
      showToast(`安装失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setInstalling((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  if (sitesLoading && sites.length === 0) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="md" />
      </div>
    );
  }

  if (sitesError) {
    return (
      <div className="flex flex-col gap-3">
        <Callout variant="danger">{sitesError}</Callout>
        <Button variant="secondary" size="sm" className="self-start"
          onClick={() => void useSkillStore.getState().loadSites()}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <MarketSourceManager kind="skill" />
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--ema-text-tertiary)] font-mono truncate">
          共 {rows.length} 个条目
        </p>
        <Button variant="ghost" size="sm" loading={refreshing} onClick={() => void handleRefresh()}>
          <span className="i-mdi:refresh text-base" aria-hidden />
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon="i-mdi:store-outline"
          title="市场暂无技能"
          hint="站点索引为空或尚未刷新,点右上角刷新"
          className="py-16"
        />
      ) : (
        rows.map((row, i) => {
          const key = `${row.siteId}:${row.entry.id}`;
          const installed = installedKeys.has(key);
          return (
            <MarketCard
              key={key}
              index={i}
              decorate="ema-card-decorate--diamond"
              installed={installed}
              installing={installing.has(key)}
              installLabel="安装"
              installedLabel="已安装"
              onInstall={() => void handleInstall(row)}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{row.entry.name}</span>
                <Badge variant="neutral">v{row.entry.version}</Badge>
                <Badge variant="neutral">{row.siteLabel}</Badge>
              </div>
              {row.entry.description && (
                <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 line-clamp-2">{row.entry.description}</p>
              )}
              <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 opacity-60">
                {formatBytes(row.entry.sizeBytes)}
              </p>
            </MarketCard>
          );
        })
      )}
    </div>
  );
}
