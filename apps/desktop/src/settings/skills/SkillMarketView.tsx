// 技能市场视图:来源管理、市场卡片与带完整性校验的安装入口。
import { useEffect, useRef, useState, type JSX } from 'react';
import { Badge, Button, Callout, EmptyState, MarketCard, Spinner } from '@ema-agent/ui';
import { useSkillStore, type MarketSkillEntry } from '../../stores/skill-store.js';
import type { GithubSkillCoords } from '@ema-agent/skills';
import { showToast } from '../../lib/toast.js';
import { MarketSourceManager } from './MarketSourceManager.js';
import { formatBytes } from './skillFormat.js';

export function SkillMarketView({
  active,
  installedNames,
  onInstall,
}: {
  active:         boolean;
  installedNames: Set<string>;
  onInstall:      (
    url: string,
    name: string,
    coords?: GithubSkillCoords,
    sha256?: string,
  ) => Promise<void>;
}): JSX.Element {
  const marketSkills  = useSkillStore((s) => s.marketSkills);
  const marketLoading = useSkillStore((s) => s.marketLoading);
  const marketError   = useSkillStore((s) => s.marketError);
  const marketSource  = useSkillStore((s) => s.marketSource);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const attemptedRef = useRef(false);

  // Fetch once on first activation; ref guard avoids the retry-on-error loop.
  useEffect(() => {
    if (active && !attemptedRef.current) {
      attemptedRef.current = true;
      void useSkillStore.getState().listMarket();
    }
  }, [active]);

  async function handleInstall(entry: MarketSkillEntry): Promise<void> {
    if (!entry.sha256) {
      showToast(
        `无法安装 ${entry.name}：该市场源没有发布完整 Bundle SHA-256，请改用带校验清单的源。`,
        { variant: 'danger' },
      );
      return;
    }
    setInstalling((prev) => new Set(prev).add(entry.name));
    try {
      // 摘要只由市场清单提供；UI 不读取资源或自行构造完整性声明。
      await onInstall(entry.url, entry.name, entry.coords, entry.sha256);
    } finally {
      setInstalling((prev) => {
        const next = new Set(prev);
        next.delete(entry.name);
        return next;
      });
    }
  }

  if (marketLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="md" />
      </div>
    );
  }

  if (marketError) {
    return (
      <div className="flex flex-col gap-3">
        <Callout variant="danger">{marketError}</Callout>
        <Button variant="secondary" size="sm" className="self-start"
          onClick={() => void useSkillStore.getState().listMarket()}>
          重试
        </Button>
      </div>
    );
  }

  if (marketSkills.length === 0) {
    return (
      <EmptyState icon="i-mdi:store-outline" title="市场暂无技能" className="py-16" />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <MarketSourceManager kind="skill" />
      {marketSource && (
        <p className="text-xs text-[var(--ema-text-tertiary)] mb-1 font-mono truncate">来源：{marketSource}</p>
      )}
      {marketSkills.map((entry, i) => {
        const installed = installedNames.has(entry.name);
        return (
          <MarketCard
            key={entry.name}
            index={i}
            decorate="ema-card-decorate--diamond"
            installed={installed}
            installing={installing.has(entry.name)}
            installLabel="安装"
            installedLabel="已安装"
            onInstall={() => void handleInstall(entry)}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{entry.name}</span>
              <Badge variant="neutral">v{entry.version}</Badge>
              {!entry.sha256 && <Badge variant="warn">未锁定</Badge>}
              {entry.tags?.map((t) => (
                <Badge key={t} variant="neutral">{t}</Badge>
              ))}
            </div>
            {entry.description && (
              <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 line-clamp-2">{entry.description}</p>
            )}
            <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 opacity-60">
              {entry.author && `${entry.author} · `}
              {entry.sizeBytes != null && formatBytes(entry.sizeBytes)}
            </p>
          </MarketCard>
        );
      })}
    </div>
  );
}
