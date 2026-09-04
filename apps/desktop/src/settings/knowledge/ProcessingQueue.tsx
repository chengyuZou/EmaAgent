// 后台任务队列：正在查看的知识库的摄入与重嵌任务行，进度由系统 SSE 原位驱动。
import { useEffect, type CSSProperties, type JSX } from 'react';
import { Button, Callout, EntityRow, IconButton, Progress, Spinner } from '@ema-agent/ui';
import { useKnowledgeStore } from '../../stores/knowledge.js';
import { showToast } from '../../lib/toast.js';
import type { IngestTaskList, ReembedTaskList } from '../../api/knowledge.js';
import type { AppEvent } from '@ema-agent/server/sse/eventHub.js';

type IngestTaskRow = IngestTaskList['items'][number];
type ReembedTaskRow = ReembedTaskList['items'][number];
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

function terminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function ProcessingQueue({ kbId, staleCount }: {
  kbId: string;
  staleCount: number;
}): JSX.Element {
  const tasks        = useKnowledgeStore((s) => s.ingestTasks);
  const reembedTasks = useKnowledgeStore((s) => s.reembedTasks);
  const queueError   = useKnowledgeStore((s) => s.ingestQueueError);

  useEffect(() => {
    void useKnowledgeStore.getState().loadIngestTasks();  // 水合持久任务队列
    void useKnowledgeStore.getState().loadReembedTasks();
  }, [kbId]);

  const list = Object.values(tasks);
  const reembedList = Object.values(reembedTasks);

  async function rebuildStale(): Promise<void> {
    try {
      const count = await useKnowledgeStore.getState().submitReembedStale();
      showToast(count > 0 ? `已加入 ${count} 篇重建` : '没有待重建的文档', { variant: 'success' });
    } catch (err) {
      showToast(`重建失败: ${err instanceof Error ? err.message : '未知错误'}`, { variant: 'danger' });
    }
  }

  return (
    <section className="flex flex-col gap-4 ema-fade-in">
      {queueError && (
        <Callout variant="danger" className="text-xs">
          任务队列刷新失败，当前内容可能已过期：{queueError}
        </Callout>
      )}

      {staleCount > 0 && (
        <Callout variant="warn" className="text-xs flex items-center justify-between gap-2">
          <span>{staleCount} 篇文档的索引待重建（更换 Embedding 后需要重建才能检索）。</span>
          <Button size="sm" variant="secondary" className="shrink-0" onClick={() => void rebuildStale()}>
            全部重建
          </Button>
        </Callout>
      )}

      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-[var(--ema-text-secondary)] px-1">摄入</p>
        {list.length === 0 ? (
          <p className="text-xs text-[var(--ema-text-tertiary)] px-1 py-2">暂无摄入任务</p>
        ) : list.map((row, i) => (
          <div key={row.id} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
            <IngestRow row={row} />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-[var(--ema-text-secondary)] px-1">重嵌</p>
        {reembedList.length === 0 ? (
          <p className="text-xs text-[var(--ema-text-tertiary)] px-1 py-2">暂无重嵌任务</p>
        ) : reembedList.map((row, i) => (
          <div key={row.id} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
            <ReembedRow row={row} />
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
        {row.status === 'failed' && (
          <Button size="sm" variant="ghost" className="shrink-0 ema-fade-in"
                  onClick={() => void useKnowledgeStore.getState().retryIngest(row.assetId)}>
            重试
          </Button>
        )}
        {(row.status === 'pending' || row.status === 'running') && (
          <Button size="sm" variant="ghost" className="shrink-0"
                  onClick={() => void useKnowledgeStore.getState().cancelIngest(row.id)
                    .catch((err: Error) => showToast(`取消失败: ${err.message}`, { variant: 'danger' }))}>
            取消
          </Button>
        )}
        {terminal(row.status) && (
          <IconButton
            variant="default" size="sm" label="删除任务记录"
            icon="i-lucide:trash-2"
            onClick={() => void useKnowledgeStore.getState().deleteIngestTask(row.id)
              .catch((err: Error) => showToast(`删除失败: ${err.message}`, { variant: 'danger' }))}
          />
        )}
      </div>

      <Progress progress={failed ? 100 : pct} barClass={barClass} height="h-1.5" animated={!failed && !done} />

      {failed && row.error && (
        <p className="text-[11px] text-[var(--ema-danger)] truncate ema-fade-in" title={row.error}>{row.error}</p>
      )}
    </EntityRow>
  );
}

function ReembedRow({ row }: { row: ReembedTaskRow }): JSX.Element {
  const failed  = row.status === 'failed' || row.status === 'cancelled';
  const done    = row.status === 'completed';
  const pending = row.status === 'pending';
  const pct     = Math.round(row.progress * 100);
  // 同一资产的多行重嵌显示 assetId 前缀会一模一样;优先显示文档名。
  const docName = useKnowledgeStore((s) =>
    s.documents.find((d) => d.id === row.assetId)?.fileName,
  ) ?? row.assetId.slice(0, 8);

  const label = row.status === 'cancelled'
    ? '已取消'
    : failed ? '重建失败' : done ? '已完成' : pending ? '排队中' : '正在重建';
  const status = failed ? '错误' : done ? '100%' : pending ? '等待' : `${pct}%`;

  return (
    <EntityRow decorate="ema-card-decorate--starfield" className="px-3 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {failed ? (
          <span className="i-mdi:alert-circle text-base shrink-0 text-[var(--ema-danger)]" aria-hidden />
        ) : done ? (
          <span className="i-mdi:check-circle text-base shrink-0 text-[var(--ema-success)]" aria-hidden />
        ) : (
          <Spinner size="sm" />
        )}
        <span className="text-sm truncate flex-1 text-[var(--ema-text-primary)]" title={row.assetId}>
          {label} · {docName}
        </span>
        <span className={`text-xs shrink-0 font-mono ${failed ? 'text-[var(--ema-danger)]' : 'text-[var(--ema-text-tertiary)]'}`}>
          {status}
        </span>
        {row.status === 'failed' && (
          <Button size="sm" variant="ghost" className="shrink-0 ema-fade-in"
                  onClick={() => void useKnowledgeStore.getState().retryReembed(row.id)
                    .catch((err: Error) => showToast(`重试失败: ${err.message}`, { variant: 'danger' }))}>
            重试
          </Button>
        )}
        {(row.status === 'pending' || row.status === 'running') && (
          <Button size="sm" variant="ghost" className="shrink-0"
                  onClick={() => void useKnowledgeStore.getState().cancelReembed(row.id)
                    .catch((err: Error) => showToast(`取消失败: ${err.message}`, { variant: 'danger' }))}>
            取消
          </Button>
        )}
        {terminal(row.status) && (
          <IconButton
            variant="default" size="sm" label="删除任务记录"
            icon="i-lucide:trash-2"
            onClick={() => void useKnowledgeStore.getState().deleteReembedTask(row.id)
              .catch((err: Error) => showToast(`删除失败: ${err.message}`, { variant: 'danger' }))}
          />
        )}
      </div>

      <Progress progress={failed ? 100 : pct}
                barClass={failed ? 'bg-[var(--ema-danger)]' : done ? 'bg-[var(--ema-success)]' : 'bg-[var(--ema-warning)]'}
                height="h-1.5" animated={!failed && !done} />

      {failed && row.error && (
        <p className="text-[11px] text-[var(--ema-danger)] truncate ema-fade-in" title={row.error}>{row.error}</p>
      )}
    </EntityRow>
  );
}
