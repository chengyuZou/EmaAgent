/** ProviderCard — single provider definition card in the selection list. */
import type { ProviderDefinition } from '../api/providers.js';
import type { Capability } from '@ema-agent/contracts';

export interface ProviderCardProps {
  def:              ProviderDefinition;
  instanceCount:    number;
  healthyCount:     number;
  selected?:        boolean;
  /** If set, show this capability's default models on the card. */
  activeCapability?: string | null;
  onClick():        void;
}

export function ProviderCard({ def, instanceCount, healthyCount, selected, activeCapability, onClick }: ProviderCardProps): JSX.Element {
  const cap = activeCapability as Capability;
  const capInfo = activeCapability && (def.capabilities as readonly string[]).includes(activeCapability)
    ? { proto: def.protocols?.[cap], models: def.defaultModels?.[cap] }
    : null;

  return (
    <button
      className={`w-full text-left px-4 py-3 rounded-xl border transition-all duration-[var(--ema-duration-base)] ${
        selected
          ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
          : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-glass-weak hover:bg-[var(--ema-surface-2)] active:scale-[0.98]'
      }`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm text-[var(--ema-text-primary)]">{def.name}</span>
        <div className="flex items-center gap-2 text-xs">
          {healthyCount > 0 && (
            <span className="text-[var(--ema-success)]">● {healthyCount}</span>
          )}
          <span className="text-[var(--ema-text-tertiary)]">{instanceCount} 个实例</span>
        </div>
      </div>
      {capInfo && Array.isArray(capInfo.models) && capInfo.models.length > 0 && (
        <div className="text-[11px] text-[var(--ema-text-tertiary)] mt-0.5 truncate">
          {capInfo.models[0]}
        </div>
      )}
      {!capInfo && def.defaultBaseUrl && (
        <div className="text-xs text-[var(--ema-text-tertiary)] mt-1 truncate">{def.defaultBaseUrl}</div>
      )}
    </button>
  );
}
