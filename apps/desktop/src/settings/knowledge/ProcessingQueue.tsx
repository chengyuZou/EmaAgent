// 后台摄入任务队列:按知识库分组展示进度,失败可重试;数据由系统 SSE 驱动。
import { useEffect, type CSSProperties, type JSX } from 'react';
import { Button, Callout, EntityRow, Progress, Spinner } from '@ema-agent/ui';
import { useKbStore, type IngestJob, type IngestStage } from '../../stores/kb-store.js';

const STAGE_LABEL: Record<IngestStage, string> = {
  validate: '校验', parse: '解析', chunk: '分块', embed: '嵌入',
};
// Bar colour per stage — literal class strings so UnoCSS scans them statically.
const STAGE_BAR: Record<IngestStage, string> = {
  validate: 'bg-[var(--ema-info)]',
  parse:    'bg-[var(--ema-info)]',
  chunk:    'bg-[var(--ema-violet)]',
  embed:    'bg-[var(--ema-warning)]',
};

export function ProcessingQueue(): JSX.Element | null {
  const jobs = useKbStore((s) => s.ingestJobs);
  const libs = useKbStore((s) => s.libs);
  const queueError = useKbStore((s) => s.ingestQueueError);

  useEffect(() => {
    void useKbStore.getState().loadIngestTasks();  // hydrate from the persistent queue
    void useKbStore.getState().loadLibs();
  }, []);

  const list = Object.values(jobs);
  if (list.length === 0 && !queueError) return null;

  // Group by kbId; preserve order of first appearance.
  const groups = new Map<string, typeof list>();
  for (const job of list) {
    const g = groups.get(job.kbId) ?? [];
    g.push(job);
    groups.set(job.kbId, g);
  }

  const libName = (kbId: string): string => libs.find((l) => l.id === kbId)?.name ?? kbId;

  return (
    <section className="flex flex-col gap-3 ema-fade-in">
      <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">处理队列</h2>
      {queueError && (
        <Callout variant="danger" className="text-xs">
          任务队列刷新失败，当前内容可能已过期：{queueError}
        </Callout>
      )}
      {[...groups.entries()].map(([kbId, kbJobs], gi) => {
        const done  = kbJobs.filter((j) => j.status === 'done').length;
        const total = kbJobs.length;
        return (
          <div key={kbId} className="flex flex-col gap-1.5 ema-stagger-in"
               style={{ '--stagger-i': gi } as CSSProperties}>
            {/* Per-KB header with completion fraction */}
            <div className="flex items-center gap-2 px-1">
              <span className="i-solar:database-linear text-sm shrink-0 text-[var(--ema-text-tertiary)]" aria-hidden />
              <p className="text-xs font-medium text-[var(--ema-text-secondary)] truncate flex-1">
                {libName(kbId)}
              </p>
              <span className="text-[11px] font-mono shrink-0 text-[var(--ema-text-tertiary)]">
                {done}/{total}
              </span>
            </div>
            {kbJobs.map((job, i) => (
              <div key={job.assetId} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
                <IngestJobRow job={job} />
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}

function IngestJobRow({ job }: { job: IngestJob }): JSX.Element {
  const failed  = job.status === 'failed' || job.status === 'partial_failed';
  const done    = job.status === 'done';
  const pending = job.status === 'pending';
  const pct     = Math.round(job.progress * 100);
  const barClass = failed ? 'bg-[var(--ema-danger)]'
    : done ? 'bg-[var(--ema-success)]'
    : job.stage ? STAGE_BAR[job.stage] : 'bg-[var(--ema-info)]';

  const label = job.status === 'partial_failed'
    ? '部分处理失败'
    : failed ? '处理失败' : done ? '已完成' : pending ? '排队中' : '正在处理';
  const status = failed ? '错误' : done ? '100%' : pending ? '等待'
    : `${job.stage ? STAGE_LABEL[job.stage] : ''} · ${pct}%`;

  return (
    <EntityRow decorate="ema-card-decorate--starfield" className={`px-3 py-2.5 flex flex-col gap-1.5 ${done ? 'ema-fade-out' : ''}`}>
      <div className="flex items-center gap-2">
        {failed ? (
          <span className="i-mdi:alert-circle text-base shrink-0 text-[var(--ema-danger)]" aria-hidden />
        ) : done ? (
          <span className="i-mdi:check-circle text-base shrink-0 text-[var(--ema-success)]" aria-hidden />
        ) : (
          <Spinner size="sm" />
        )}
        <span className="text-sm truncate flex-1 text-[var(--ema-text-primary)]" title={job.fileName}>
          {label} · {job.fileName}
        </span>
        <span className={`text-xs shrink-0 font-mono ${failed ? 'text-[var(--ema-danger)]' : 'text-[var(--ema-text-tertiary)]'}`}>
          {status}
        </span>
        {failed && (
          <Button size="sm" variant="ghost" className="shrink-0 ema-fade-in"
                  onClick={() => void useKbStore.getState().retryIngest(job.assetId)}>
            重试
          </Button>
        )}
      </div>

      <Progress progress={failed ? 100 : pct} barClass={barClass} height="h-1.5" animated={!failed && !done} />

      {failed && job.error && (
        <p className="text-[11px] text-[var(--ema-danger)] truncate ema-fade-in" title={job.error}>{job.error}</p>
      )}
    </EntityRow>
  );
}
