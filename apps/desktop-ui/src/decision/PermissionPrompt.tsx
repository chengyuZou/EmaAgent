// 展示单次工具权限请求，并把用户的允许或拒绝决定提交给后端。
import { useEffect, useRef, useState } from 'react';
import { Button, Card, Progress } from '@ema-agent/ui';
import { permissionApi } from '../api/permission.js';
import { HumanDescriptionPanel } from './HumanDescriptionPanel.js';
import { RawCommandPanel } from './RawCommandPanel.js';
import type { PermissionResponse } from '@ema-agent/permission';

export interface PermissionPromptProps {
  promptId:                 string;
  toolName:                 string;
  toolDescription?:         string;
  args:                     unknown;
  hint:                     string;
  humanDescription?:        string;
  humanDescriptionPending?: boolean;
  /** If set, auto-deny after this many milliseconds. 0 or absent = no timeout. */
  timeoutMs?:               number;
  /**
   * Called after the backend has been notified.
   * `decision` is 'allow' for any allow-family action, 'deny' for any deny-family action.
   */
  onResolve(decision: 'allow' | 'deny'): void;
}

export function PermissionPrompt({
  promptId,
  toolName,
  toolDescription,
  args,
  hint,
  humanDescription,
  humanDescriptionPending,
  timeoutMs,
  onResolve,
}: PermissionPromptProps): JSX.Element {
  const totalSeconds = timeoutMs ? Math.ceil(timeoutMs / 1000) : 0;
  const [secondsLeft, setSecondsLeft] = useState(totalSeconds);
  const resolved = useRef(false);

  const handleResolve = (decision: 'allow' | 'deny'): void => {
    if (resolved.current) return;
    resolved.current = true;
    onResolve(decision);
  };

  const respond = async (response: PermissionResponse, decision: 'allow' | 'deny'): Promise<void> => {
    try { await permissionApi.respond(promptId, response); } catch { /* sidecar down */ }
    handleResolve(decision);
  };

  // ── Countdown ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!totalSeconds) return;
    resolved.current = false;
    setSecondsLeft(totalSeconds);

    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { clearInterval(id); return 0; }
        return s - 1;
      });
    }, 1000);

    return () => clearInterval(id);
  }, [promptId, totalSeconds]);

  // Side effects run outside the updater to avoid double-fire in Strict Mode.
  useEffect(() => {
    if (secondsLeft !== 0 || !totalSeconds || resolved.current) return;
    void permissionApi.respond(promptId, { action: 'deny' }).catch(() => {});
    handleResolve('deny');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft]);

  const progress = totalSeconds > 0 ? (secondsLeft / totalSeconds) * 100 : 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Card variant="elevated" padding="lg" className="shadow-[var(--ema-shadow-3)] max-w-lg w-full">
      <HumanDescriptionPanel
        description={humanDescription ?? toolDescription ?? (hint || `即将运行 ${toolName}`)}
        toolName={toolName}
        pending={humanDescriptionPending ?? false}
      />

      <RawCommandPanel toolName={toolName} args={args} />

      {/* Action row */}
      <div className="flex gap-2 mt-4 justify-between items-center">
        <Button
          variant="danger"
          size="sm"
          onClick={() => void respond({ action: 'deny' }, 'deny')}
        >
          拒绝
        </Button>

        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void respond({ action: 'allow_session' }, 'allow')}
          >
            此会话允许
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void respond({ action: 'allow' }, 'allow')}
          >
            允许
          </Button>
        </div>
      </div>

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
