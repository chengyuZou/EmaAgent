// 后台摄入任务队列：当前活跃知识库的 Route 原生任务行，进度由系统 SSE 原位驱动。
import { useEffect, type CSSProperties, type JSX } from 'react';
import { Button, Callout, EntityRow, Progress, Spinner } from '@ema-agent/ui';
import { useKnowledgeStore } from '../../stores/knowledge.js';
import type { IngestTaskList } from '../../api/knowledge.js';
import type { AppEvent } from '@ema-agent/server/sse/eventHub.js';

type IngestTaskRow = IngestTaskList['items'][number];
/** 阶段集合的拥有方是 kb_ingest_progress 事件的 stage 联合。 */
type IngestStage = Extract<AppEvent, { type: 'kb_ingest_progress' }>['stage'];

// 阶段中文标签与进度条颜色；Record 穷尽检查保证后端联合新增成员时这里编译报错。
const STAGE_LABEL: Record<IngestStage, string> = {
  validate: '校验', parse: '解析', chunk: '分块', embed: '嵌入',
};
const STAGE_BAR: Record<IngestStage, string> = {
  validate: 'bg-[var(--ema-info)]',
  parse:    'bg-[var(--ema-info)]',
  chunk:    'bg-[var(--ema-violet)]',
  embed:    'bg-[var(--ema-warning)]',
};

/** 任务行的 stage 是宽松 string（持久列）；命中已知阶段才给标签，未知阶段原样展示。 */
function stageMeta(stage: string | undefined): { label: string; bar: string } | undefined {
  if (stage === 'validate' || stage === 'parse' || stage === 'chunk' || stage === 'embed') {
    return { label: STAGE_LABEL[stage], bar: STAGE_BAR[stage] };
  }
  return undefined;
}

export function ProcessingQueue(): JSX.Element | null {
  const tasks = useKnowledgeStore((s) => s.ingestTasks);
  const libs = useKnowledgeStore((s) => s.libs);
  const queueError = useKnowledgeStore((s) => s.ingestQueueError);

  useEffect(() => {
    void useKnowledgeStore.getState().loadIngestTasks();  // 水合持久任务队列
    void useKnowledgeStore.getState().loadLibs();
  }, []);

  const list = Object.values(tasks);
  if (list.length === 0 && !queueError) return null;

  // 队列只含当前活跃库的任务（Route 缺省解析活跃库），单一分组无需再按库拆开。
  const activeLibName = libs.find((l) => l.isActive)?.name ?? '当前知识库';
  const done = list.filter((t) => t.status === 'completed').length;

  return (
    <section className="flex flex-col gap-3 ema-fade-in">
      <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">处理队列</h2>
      {queueError && (
        <Callout variant="danger" className="text-xs">
          任务队列刷新失败，当前内容可能已过期：{queueError}
        </Callout>
      )}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 px-1">
          <span className="i-solar:database-linear text-sm shrink-0 text-[var(--ema-text-tertiary)]" aria-hidden />
          <p className="text-xs font-medium text-[var(--ema-text-secondary)] truncate flex-1">
            {activeLibName}
          </p>
          <span className="text-[11px] font-mono shrink-0 text-[var(--ema-text-tertiary)]">
            {done}/{list.length}
          </span>
        </div>
        {list.map((row, i) => (
          <div key={row.assetId} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
            <IngestRow row={row} />
          </div>
        ))}
      </div>
    </section>
  );
}

function IngestRow({ row }: { row: IngestTaskRow }): JSX.Element {
  const failed  = row.status === 'failed' || row.status === 'cancelled';
  const done    = row.status === 'completed';
  const pending = row.status === 'pending';
  const pct     = Math.round(row.progress * 100);
  const meta    = stageMeta(row.stage);
  const barClass = failed ? 'bg-[var(--ema-danger)]'
    : done ? 'bg-[var(--ema-success)]'
    : meta ? meta.bar : 'bg-[var(--ema-info)]';

  const label = row.status === 'cancelled'
    ? '已取消'
    : failed ? '处理失败' : done ? '已完成' : pending ? '排队中' : '正在处理';
  const status = failed ? '错误' : done ? '100%' : pending ? '等待'
    : `${meta?.label ?? row.stage ?? ''} · ${pct}%`;

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
        <span className="text-sm truncate flex-1 text-[var(--ema-text-primary)]" title={row.fileName}>
          {label} · {row.fileName}
        </span>
        <span className={`text-xs shrink-0 font-mono ${failed ? 'text-[var(--ema-danger)]' : 'text-[var(--ema-text-tertiary)]'}`}>
          {status}
        </span>
        {failed && (
          <Button size="sm" variant="ghost" className="shrink-0 ema-fade-in"
                  onClick={() => void useKnowledgeStore.getState().retryIngest(row.assetId)}>
            重试
          </Button>
        )}
      </div>

      <Progress progress={failed ? 100 : pct} barClass={barClass} height="h-1.5" animated={!failed && !done} />

      {failed && row.error && (
        <p className="text-[11px] text-[var(--ema-danger)] truncate ema-fade-in" title={row.error}>{row.error}</p>
      )}
    </EntityRow>
  );
}
