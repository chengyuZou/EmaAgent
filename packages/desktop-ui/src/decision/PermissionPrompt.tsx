import { useState } from 'react';
import { Button, Card } from '@ema-agent/ui';
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
  onResolve(decision: 'allow' | 'deny'): void;
}

export function PermissionPrompt({
  promptId,
  toolName,
  args,
  hint,
  humanDescription,
  humanDescriptionPending,
  onResolve,
}: PermissionPromptProps): JSX.Element {
  const [countdown, _setCountdown] = useState<number | null>(null);

  return (
    <Card variant="elevated" padding="lg" className="shadow-2xl max-w-lg w-full">
      <HumanDescriptionPanel
        description={humanDescription ?? hint}
        toolName={toolName}
        pending={humanDescriptionPending ?? false}
      />

      <RawCommandPanel toolName={toolName} args={args} />

      {countdown !== null && (
        <p className="text-xs text-neutral-500 mt-2">剩余 {countdown}s</p>
      )}

      <div className="flex gap-3 mt-4 justify-end">
        <Button
          variant="danger"
          size="sm"
          onClick={async () => {
            try { await permissionApi.respond(promptId, { action: 'deny' }); } catch { /* sidecar down */ }
            onResolve('deny');
          }}
        >
          拒绝
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={async () => {
            try { await permissionApi.respond(promptId, { action: 'allow' }); } catch { /* sidecar down */ }
            onResolve('allow');
          }}
        >
          允许
        </Button>
      </div>
    </Card>
  );
}
