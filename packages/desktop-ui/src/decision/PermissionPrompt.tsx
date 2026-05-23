/**
 * PermissionPrompt — permission allow/deny modal.
 */

import { useState } from 'react';
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
  toolName,
  args,
  hint,
  humanDescription,
  humanDescriptionPending,
  onResolve,
}: PermissionPromptProps): JSX.Element {
  const [countdown, _setCountdown] = useState<number | null>(null);

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-2xl">
      <HumanDescriptionPanel
        description={humanDescription ?? hint}
        toolName={toolName}
        pending={humanDescriptionPending ?? false}
      />

      <RawCommandPanel toolName={toolName} args={args} />

      {countdown !== null && (
        <div className="text-xs text-gray-500 mt-2">剩余 {countdown}s</div>
      )}

      <div className="flex gap-3 mt-4 justify-end">
        <button
          className="px-4 py-2 rounded-xl bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
          onClick={() => onResolve('deny')}
        >
          拒绝
        </button>
        <button
          className="px-4 py-2 rounded-xl bg-green-500/20 text-green-300 hover:bg-green-500/30 transition-colors"
          onClick={() => onResolve('allow')}
        >
          允许
        </button>
      </div>
    </div>
  );
}
