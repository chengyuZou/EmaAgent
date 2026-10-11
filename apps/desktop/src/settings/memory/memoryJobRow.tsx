import { memo, useCallback, useState, type JSX } from 'react';
import { Badge, Button, Markdown, Spinner } from '@ema-agent/ui';
import { memoryApi, type MemoryJob } from '../../api/memory.js';
import {
  formatJobTime,
  JOB_KIND_LABEL,
  JOB_RESULT_LABEL,
  JOB_STATUS_LABEL,
  JOB_STATUS_VARIANT,
} from './memoryLabels.js';
import { useMemoryQuery } from './useMemoryQuery.js';

interface MemoryJobRowProps {
  readonly job: MemoryJob;
  readonly active: boolean;
  readonly compact?: boolean;
  readonly onIgnored: () => void;
}

export const MemoryJobRow = memo(function MemoryJobRow({
  job,
  active,
  compact = false,
  onIgnored,
}: MemoryJobRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [ignoring, setIgnoring] = useState(false);
  const [ignoreError, setIgnoreError] = useState<string | null>(null);
  const readDetail = useCallback(
    (signal: AbortSignal) => memoryApi.jobDetail(job.id, signal),
    [job.id, job.result, job.status],
  );
  const detail = useMemoryQuery(expanded && active, 0, readDetail);
  const relationship = job.kind.startsWith('relationship_');
  let resultLabel = JOB_STATUS_LABEL[job.status];
  if (job.result !== null) {
    resultLabel = JOB_RESULT_LABEL[job.result];
  }

  let detailLabel = '查看结果';
  if (expanded) {
    detailLabel = '收起详情';
  } else if (job.status === 'failed') {
    detailLabel = '查看错误';
  }

  async function ignore(): Promise<void> {
    setIgnoring(true);
    setIgnoreError(null);
    try {
      // 忽略是已经提交的写操作, 不随页面隐藏取消. 返回页面时重新读取 SQL 结果.
      await memoryApi.ignoreJob(job.id);
      onIgnored();
    } catch (reason) {
      setIgnoreError(reason instanceof Error ? reason.message : '忽略提醒失败');
    } finally {
      setIgnoring(false);
    }
  }

  return (
    <article
      className={`ema-memory-job ${compact ? 'ema-memory-job--compact' : ''}`}
      data-status={job.status}
    >
      <div className="ema-memory-job-heading">
        <span
          className={relationship ? 'i-lucide:heart' : 'i-lucide:briefcase-business'}
          aria-hidden
        />
        <h3>
          {JOB_KIND_LABEL[job.kind]}
          {relationship && job.characterName ? ` - ${job.characterName}` : ''}
        </h3>

        {!compact && (
          <Badge
            variant={JOB_STATUS_VARIANT[job.status]}
            dot={job.status === 'running'}
          >
            {JOB_STATUS_LABEL[job.status]}
          </Badge>
        )}
        <time dateTime={new Date(job.createdAt).toISOString()}>
          {formatJobTime(job.createdAt)}
        </time>
      </div>

      <p className="ema-memory-job-result">
        {resultLabel}
        {job.status === 'failed' && job.reminderIgnored && (
          <span className="ema-memory-ignored">提醒已忽略</span>
        )}
      </p>

      <div className="ema-memory-job-actions">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
          aria-controls={`memory-job-${job.id}`}
        >
          {detailLabel}
          <span
            className="i-lucide:chevron-down ema-memory-detail-chevron"
            data-expanded={expanded}
            aria-hidden
          />
        </Button>

        {job.status === 'failed' && !job.reminderIgnored && (
          <Button
            size="sm"
            variant="ghost"
            icon="i-lucide:bell-off"
            loading={ignoring}
            onClick={() => void ignore()}
          >
            忽略提醒
          </Button>
        )}
      </div>

      {ignoreError && (
        <p className="ema-memory-inline-error" role="alert">
          {ignoreError}
        </p>
      )}
      {expanded && (
        <div className="ema-memory-job-detail" id={`memory-job-${job.id}`}>
          {!detail.value && detail.loading && (
            <Spinner size="sm" />
          )}
          {detail.error && (
            <p className="ema-memory-inline-error" role="alert">
              {detail.error}
            </p>
          )}
          {detail.value?.error && (
            <pre className="ema-memory-job-error">{detail.value.error}</pre>
          )}
          {detail.value?.content && (
            <Markdown source={detail.value.content} />
          )}
          {detail.value && !detail.value.error && !detail.value.content && (
            <p>{resultLabel}</p>
          )}
          {detail.value?.result === 'consolidated' && (
            <p className="ema-memory-note">
              此提取内容已参与整合, 不表示每句话都写入了正式记忆.
            </p>
          )}
        </div>
      )}
    </article>
  );
}, (previous, next) => (
  previous.active === next.active
  && previous.compact === next.compact
  && previous.onIgnored === next.onIgnored
  && previous.job.id === next.job.id
  && previous.job.kind === next.job.kind
  && previous.job.status === next.job.status
  && previous.job.createdAt === next.job.createdAt
  && previous.job.reminderIgnored === next.job.reminderIgnored
  && previous.job.characterName === next.job.characterName
  && previous.job.result === next.job.result
));
