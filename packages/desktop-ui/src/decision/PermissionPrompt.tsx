import { useEffect, useRef, useState } from 'react';
import { Button, Card, Progress } from '@ema-agent/ui';
import { permissionApi } from '../api/permission.js';
import { HumanDescriptionPanel } from './HumanDescriptionPanel.js';
import { RawCommandPanel } from './RawCommandPanel.js';
import type { PermissionResponse, RuleScope } from '@ema-agent/permission';

const SCOPE_LABELS: Record<RuleScope, string> = {
  session: '此会话',
  project: '本项目',
  global:  '全局',
};

export interface PermissionPromptProps {
  promptId:                 string;
  toolName:                 string;
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
  args,
  hint,
  humanDescription,
  humanDescriptionPending,
  timeoutMs,
  onResolve,
}: PermissionPromptProps): JSX.Element {
  const totalSeconds = timeoutMs ? Math.ceil(timeoutMs / 1000) : 0;
  const [secondsLeft, setSecondsLeft]   = useState(totalSeconds);
  const [scopeFor, setScopeFor]         = useState<'allow' | 'deny' | null>(null);
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
    <Card variant="elevated" padding="lg" className="shadow-2xl max-w-lg w-full">
      <HumanDescriptionPanel
        description={humanDescription ?? hint}
        toolName={toolName}
        pending={humanDescriptionPending ?? false}
      />

      <RawCommandPanel toolName={toolName} args={args} />

      {/* Inline scope picker — shown when user clicks "始终…" */}
      {scopeFor !== null && (
        <div className="mt-3 p-2 rounded-lg bg-neutral-800/50 border border-neutral-600/30 flex items-center gap-2 flex-wrap text-xs">
          <span className="text-neutral-400 shrink-0">
            {scopeFor === 'allow' ? '始终允许范围：' : '始终拒绝范围：'}
          </span>
          {(['session', 'project', 'global'] as const).map((scope) => (
            <Button
              key={scope}
              variant={scopeFor === 'allow' ? 'primary' : 'danger'}
              size="sm"
              onClick={() => {
                setScopeFor(null);
                void respond(
                  scopeFor === 'allow'
                    ? { action: 'always_allow', scope }
                    : { action: 'always_deny',  scope },
                  scopeFor === 'allow' ? 'allow' : 'deny',
                );
              }}
            >
              {SCOPE_LABELS[scope]}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setScopeFor(null)}
          >
            取消
          </Button>
        </div>
      )}

      {/* Primary action row */}
      <div className="flex gap-2 mt-4 justify-between items-center">
        <div className="flex gap-2">
          <Button
            variant="danger"
            size="sm"
            onClick={() => void respond({ action: 'deny' }, 'deny')}
          >
            拒绝
          </Button>
        </div>

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

      {/* Secondary row: persistent allow / deny */}
      <div className="flex gap-2 mt-2 justify-between">
        <Button
          variant="ghost"
          size="sm"
          className={scopeFor === 'deny' ? 'text-red-400' : 'text-neutral-500 hover:text-red-400'}
          onClick={() => setScopeFor(scopeFor === 'deny' ? null : 'deny')}
        >
          始终拒绝…
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={scopeFor === 'allow' ? 'text-primary-300' : 'text-neutral-500 hover:text-primary-300'}
          onClick={() => setScopeFor(scopeFor === 'allow' ? null : 'allow')}
        >
          始终允许…
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
