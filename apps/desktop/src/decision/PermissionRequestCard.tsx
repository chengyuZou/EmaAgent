// 展示单次工具权限请求，并把用户的允许或拒绝决定提交给后端。
import { useEffect, useRef, useState } from 'react';
import { Button, Card, Progress } from '@ema-agent/ui';
import { DecisionSubmissionFeedback, HumanDescriptionPanel } from './HumanDescriptionPanel.js';
import { RawCommandPanel } from './RawCommandPanel.js';
import type { PermissionRequest, PermissionResponse } from '@ema-agent/permission';

export interface PermissionRequestCardProps {
  request:         PermissionRequest;
  submitting:      boolean;
  submissionError?: string;
  /** 设置了 timeoutMs 时倒计时结束自动拒绝；0 或不设 = 无超时。 */
  timeoutMs?:               number;
  onRespond(response: PermissionResponse): void;
}

export function PermissionRequestCard({
  request,
  submitting,
  submissionError,
  timeoutMs,
  onRespond,
}: PermissionRequestCardProps): JSX.Element {
  const totalSeconds = timeoutMs ? Math.ceil(timeoutMs / 1000) : 0;
  const [secondsLeft, setSecondsLeft] = useState(totalSeconds);
  const timeoutSubmitted = useRef(false);

  // ── 倒计时 ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!totalSeconds) return;
    timeoutSubmitted.current = false;
    setSecondsLeft(totalSeconds);

    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { clearInterval(id); return 0; }
        return s - 1;
      });
    }, 1000);

    return () => clearInterval(id);
  }, [request.toolCallId, totalSeconds]);

  // 副作用放在 updater 外，避免 Strict Mode 下重复触发。
  useEffect(() => {
    if (secondsLeft !== 0 || !totalSeconds || timeoutSubmitted.current) return;
    timeoutSubmitted.current = true;
    onRespond({ action: 'deny', reason: 'permission request timed out' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft]);

  const progress = totalSeconds > 0 ? (secondsLeft / totalSeconds) * 100 : 0;

  // ── 渲染 ───────────────────────────────────────────────────────────────────

  return (
    <Card variant="elevated" padding="lg" className="shadow-[var(--ema-shadow-3)] max-w-lg w-full">
      <HumanDescriptionPanel
        description={request.toolDescription ?? `即将运行 ${request.toolName}`}
        toolName={request.toolName}
      />

      <RawCommandPanel toolName={request.toolName} args={request.input} />

      {/* 操作行 */}
      <div className="flex gap-2 mt-4 justify-between items-center">
        <Button
          variant="danger"
          size="sm"
          disabled={submitting}
          onClick={() => onRespond({ action: 'deny' })}
        >
          拒绝
        </Button>

        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={submitting}
            onClick={() => onRespond({ action: 'allowSession' })}
          >
            本会话允许此操作
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={submitting}
            onClick={() => onRespond({ action: 'allow' })}
          >
            允许
          </Button>
        </div>
      </div>

      <DecisionSubmissionFeedback submitting={submitting} error={submissionError} />

      {totalSeconds > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          <p className="text-xs text-right text-[var(--ema-text-tertiary)]">{secondsLeft} 秒后自动拒绝</p>
          <Progress
            progress={progress}
            height="h-1"
            barClass="bg-[var(--ema-warning)]"
            animated={false}
          />
        </div>
      )}
    </Card>
  );
}
