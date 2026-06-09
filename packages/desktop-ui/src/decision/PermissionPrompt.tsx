import { useEffect, useRef, useState } from 'react';
import { Button, Card, Progress } from '@ema-agent/ui';
import { permissionApi } from '../api/permission.js';
import { HumanDescriptionPanel } from './HumanDescriptionPanel.js';
import { RawCommandPanel } from './RawCommandPanel.js';

export interface PermissionPromptProps {
  promptId:                 string;
  toolName:                 string;
  args:                     unknown;
  hint:                     string;
  humanDescription?:        string;
  humanDescriptionPending?: boolean;
  /** If set, auto-deny after this many milliseconds. 0 or absent = no timeout. */
  timeoutMs?:               number;
  onResolve(decision: 'allow' | 'deny'): void;
}

export function PermissionPrompt({
  promptId,
  toolName,
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

  // Side effects run outside the updater to avoid double-fire in Strict Mode / concurrent mode.
  useEffect(() => {
    if (secondsLeft !== 0 || !totalSeconds || resolved.current) return;
    void permissionApi.respond(promptId, { action: 'deny' }).catch(() => {});
    handleResolve('deny');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft]);

  const progress = totalSeconds > 0 ? (secondsLeft / totalSeconds) * 100 : 0;

  return (
    <Card variant="elevated" padding="lg" className="shadow-2xl max-w-lg w-full">
      <HumanDescriptionPanel
        description={humanDescription ?? hint}
        toolName={toolName}
        pending={humanDescriptionPending ?? false}
      />

      <RawCommandPanel toolName={toolName} args={args} />

      <div className="flex gap-3 mt-4 justify-end">
        <Button
          variant="danger"
          size="sm"
          onClick={async () => {
            try { await permissionApi.respond(promptId, { action: 'deny' }); } catch { /* sidecar down */ }
            handleResolve('deny');
          }}
        >
          拒绝
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={async () => {
            try { await permissionApi.respond(promptId, { action: 'allow' }); } catch { /* sidecar down */ }
            handleResolve('allow');
          }}
        >
          允许
        </Button>
      </div>

      {totalSeconds > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          <p className="text-xs text-neutral-400 text-right">{secondsLeft} 秒后自动拒绝</p>
          <Progress
            progress={progress}
            height="h-1"
            barClass="bg-amber-400/70"
            animated={false}
          />
        </div>
      )}
    </Card>
  );
}
