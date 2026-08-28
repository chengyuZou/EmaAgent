// 记忆维护:手动整合两轨、存储清理与全部清除的触发口,以及最近后台任务列表(重试/取消)。
import { useEffect, useState, type JSX } from 'react';
import {
  Badge, Button, Callout, ConfirmDialog, Divider, ScrollArea, Spinner,
} from '@ema-agent/ui';
import { useMemoryStore } from '../../stores/memory.js';
import { showToast } from '../../lib/toast.js';
import {
  JOB_KIND_LABEL, JOB_STATUS_LABEL, JOB_STATUS_VARIANT, relativeTime,
} from './memoryLabels.js';

export function MaintenanceTab(): JSX.Element {
  const jobs         = useMemoryStore((s) => s.jobs);
  const jobsLoading  = useMemoryStore((s) => s.jobsLoading);
  const jobsError    = useMemoryStore((s) => s.jobsError);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    void useMemoryStore.getState().refreshJobs();
  }, []);

  async function run(kind: 'work_consolidation' | 'relationship_consolidation' | 'clear_memory' | 'storage_cleanup'): Promise<void> {
    setBusy(kind);
    try {
      const store = useMemoryStore.getState();
      if (kind === 'work_consolidation' || kind === 'relationship_consolidation') {
        await store.consolidate(kind);
      } else {
        await store.maintenance(kind);
      }
      showToast('已加入后台队列', { variant: 'success' });
    } catch (err: unknown) {
      showToast(err instanceof Error ? `操作失败：${err.message}` : '操作失败', { variant: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="ema-slide-down">
        <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">手动整合</h3>
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mt-0.5">
          立即把未整合的提取结果写入正式记忆文件;冷却期不影响手动触发。
        </p>
      </div>

      <div className="flex gap-2 ema-slide-up">
        <Button
          variant="secondary"
          size="sm"
          loading={busy === 'work_consolidation'}
          disabled={busy !== null}
          onClick={() => void run('work_consolidation')}
        >
          整合工作轨
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={busy === 'relationship_consolidation'}
          disabled={busy !== null}
          onClick={() => void run('relationship_consolidation')}
        >
          整合关系轨
        </Button>
      </div>

      <Divider />

      <div className="ema-slide-down">
        <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">存储维护</h3>
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mt-0.5">
          按存储上限清理最旧、最冷的记忆文件;清除全部记忆不可恢复。
        </p>
      </div>

      <div className="flex gap-2 ema-slide-up">
        <Button
          variant="secondary"
          size="sm"
          loading={busy === 'storage_cleanup'}
          disabled={busy !== null}
          onClick={() => void run('storage_cleanup')}
        >
          按上限清理
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={busy !== null}
          onClick={() => setConfirmClear(true)}
        >
          清除全部记忆
        </Button>
      </div>

      {jobsError && <Callout variant="danger">{jobsError}</Callout>}

      <Divider />

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">最近后台任务</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={jobsLoading}
          onClick={() => void useMemoryStore.getState().refreshJobs()}
        >
          <span className="i-mdi:refresh text-base" aria-hidden />
        </Button>
      </div>

      {jobsLoading && !jobs && (
        <div className="flex justify-center py-6"><Spinner size="sm" /></div>
      )}

      {jobs && jobs.length === 0 && (
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] opacity-60 py-2">
          暂无后台任务;提取任务会在对话结束后自动入队。
        </p>
      )}

      {jobs && jobs.length > 0 && (
        <ScrollArea viewportClassName="max-h-72">
          <div className="flex flex-col gap-1.5 pr-1">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center gap-2 rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-3 py-2 text-xs"
              >
                <Badge variant={JOB_STATUS_VARIANT[job.status]} dot={job.status === 'running'}>
                  {JOB_STATUS_LABEL[job.status]}
                </Badge>
                <span className="font-semibold text-[var(--ema-text-secondary)]">
                  {JOB_KIND_LABEL[job.kind]}
                </span>
                <span className="text-[var(--ema-text-tertiary)] opacity-60">
                  {relativeTime(job.createdAt)}
                </span>
                {job.error && (
                  <span className="flex-1 truncate text-[var(--ema-danger)]" title={job.error}>
                    {job.error}
                  </span>
                )}
                <span className="flex-1" />
                {job.status === 'failed' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void useMemoryStore.getState().retryJob(job.id)
                        .catch((err: Error) => showToast(`重试失败: ${err.message}`, { variant: 'danger' }));
                    }}
                  >
                    重试
                  </Button>
                )}
                {(job.status === 'pending' || job.status === 'running') && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void useMemoryStore.getState().cancelJob(job.id)
                        .catch((err: Error) => showToast(`取消失败: ${err.message}`, { variant: 'danger' }));
                    }}
                  >
                    取消
                  </Button>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      <ConfirmDialog
        open={confirmClear}
        message="确定清除全部长期记忆？记忆文件将被移除且不可恢复。"
        confirmText="全部清除"
        onConfirm={() => {
          setConfirmClear(false);
          void run('clear_memory');
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
