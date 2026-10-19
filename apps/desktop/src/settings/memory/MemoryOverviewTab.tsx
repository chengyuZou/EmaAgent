import { memo, type JSX } from 'react';
import { Callout, Markdown, Spinner } from '@ema-agent/ui';
import { memoryApi, type MemoryPreview } from '../../api/memory.js';
import { useWindowSuspension } from '../../hooks/use-window-suspension.js';
import { MainView, useMainNavigationStore } from '../../layout/navigation.js';
import { PageHeader } from '../shared/PageHeader.js';
import { MemoryJobRow } from './memoryJobRow.js';
import { MemoryStorageUsage } from './MemoryStorageUsage.js';
import { useMemoryQuery } from './useMemoryQuery.js';

const OVERVIEW_REFRESH_INTERVAL_MS = 30_000;
const RECENT_JOBS_REFRESH_INTERVAL_MS = 5_000;

export function MemoryOverviewTab(): JSX.Element {
  const view = useMainNavigationStore(state => state.activeView);
  const tab = useMainNavigationStore(state => state.settingsTab);
  const suspended = useWindowSuspension();
  const active = view === MainView.Settings
    && (tab === 'memory' || tab === 'memory-overview')
    && !suspended;

  const previews = useMemoryQuery(active, OVERVIEW_REFRESH_INTERVAL_MS, memoryApi.overview);
  const recent = useMemoryQuery(active, RECENT_JOBS_REFRESH_INTERVAL_MS, memoryApi.recentJobs);

  return (
    <div className="ema-memory-overview">
      <div className="ema-memory-overview-header">
        <PageHeader
          title="Memory"
          description="查看已保存的记忆, 以及最近几条处理结果."
        />

        <MemoryStorageUsage active={active} />
      </div>

      <div className="ema-memory-overview-columns">
        <section className="ema-memory-previews" aria-label="已保存的记忆预览">
          {previews.error && (
            <Callout variant="danger">{previews.error}</Callout>
          )}
          {!previews.value && previews.loading && (
            <div className="ema-memory-section-loading">
              <Spinner size="sm" />
            </div>
          )}
          {previews.value?.items.length === 0 && (
            <p className="ema-memory-empty">
              还没有已保存的记忆. 有可保存的提取内容时, 后台会继续整理.
            </p>
          )}
          {previews.value?.items.map(preview => (
            <MemoryPreviewCard
              key={preview.path}
              path={preview.path}
              content={preview.content}
              truncated={preview.truncated}
            />
          ))}
        </section>

        <aside className="ema-memory-recent" aria-label="最近处理">
          <div className="ema-memory-section-heading">
            <h2>最近处理</h2>
            <span>最近 3 条</span>
          </div>

          {recent.error && (
            <p className="ema-memory-inline-error" role="alert">
              {recent.error}
            </p>
          )}
          {!recent.value && recent.loading && (
            <div className="ema-memory-section-loading">
              <Spinner size="sm" />
            </div>
          )}
          {recent.value?.items.length === 0 && (
            <p className="ema-memory-empty">还没有处理记录.</p>
          )}
          <div className="ema-memory-timeline">
            {recent.value?.items.map(job => (
              <MemoryJobRow
                key={job.id}
                job={job}
                active={active}
                compact
                onIgnored={recent.refresh}
              />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

const MemoryPreviewCard = memo(function MemoryPreviewCard({
  path,
  content,
  truncated,
}: MemoryPreview): JSX.Element {
  return (
    <article className="ema-memory-preview">
      <div className="ema-memory-section-heading">
        <h2>
          <span className="i-lucide:file-text" aria-hidden />
          <span>{path}</span>
        </h2>
        <span className="ema-memory-saved">已保存</span>
      </div>

      <Markdown source={content} streaming={truncated} />

      {truncated && (
        <p className="ema-memory-note">仅显示文件开头, 完整内容可在文件栏查看.</p>
      )}
    </article>
  );
});

