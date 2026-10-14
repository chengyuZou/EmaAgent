import { useEffect, useId, useState, type JSX } from 'react';
import type { Turn } from '@ema-agent/turn';
import { Button } from '@ema-agent/ui';

export function TurnError({
  errorCode,
  errorMessage,
}: Pick<Turn, 'errorCode' | 'errorMessage'>): JSX.Element | null {
  const titleId = useId();
  const messageId = useId();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (errorCode === null && errorMessage === null) return null;

  const message = errorMessage ?? '';
  const preview = message.slice(0, 600).split('\n').slice(0, 6).join('\n');
  const isLong = preview.length < message.length;
  const displayMessage = isLong && !expanded ? `${preview}…` : message;

  async function copyError(): Promise<void> {
    try {
      await navigator.clipboard.writeText([errorCode, errorMessage].filter(Boolean).join('\n'));
      setCopyFailed(false);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <section className="ema-turn-error" aria-labelledby={titleId}>
      <div className="ema-turn-error-heading">
        <span className="i-lucide:circle-alert shrink-0" aria-hidden />
        <h3 id={titleId}>本轮执行失败</h3>
      </div>
      {errorCode !== null && <div className="ema-turn-error-code">{errorCode}</div>}
      {message && (
        <div
          id={messageId}
          className="ema-turn-error-message"
          data-collapsed={isLong && !expanded || undefined}
        >
          {displayMessage}
        </div>
      )}
      <div className="ema-turn-error-actions">
        {isLong && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={messageId}
            icon={expanded ? 'i-lucide:chevron-up' : 'i-lucide:chevron-down'}
            onClick={() => setExpanded(value => !value)}
          >
            {expanded ? '收起错误详情' : '展开完整错误'}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={copied ? 'i-lucide:check' : 'i-lucide:copy'}
          aria-label="复制完整错误"
          onClick={() => void copyError()}
        >
          {copied ? '已复制' : '复制错误'}
        </Button>
        {copyFailed && <span role="status">复制失败，请选择错误文字手动复制。</span>}
      </div>
    </section>
  );
}
