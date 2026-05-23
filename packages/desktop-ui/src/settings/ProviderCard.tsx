/** ProviderCard — single provider definition card in the selection list. */
import type { ProviderDefinitionWire } from '../api/providers.js';

export interface ProviderCardProps {
  def:           ProviderDefinitionWire;
  instanceCount: number;
  healthyCount:  number;
  selected?:     boolean;
  onClick():     void;
}

export function ProviderCard({ def, instanceCount, healthyCount, selected, onClick }: ProviderCardProps): JSX.Element {
  return (
    <button
      className={`w-full text-left px-4 py-3 rounded-xl border transition-colors ${
        selected
          ? 'border-pink-400/40 bg-pink-400/10'
          : 'border-gray-700 bg-gray-800 hover:bg-gray-750'
      }`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{def.name}</span>
        <div className="flex items-center gap-2 text-xs">
          {healthyCount > 0 && <span className="text-green-400">● {healthyCount}</span>}
          <span className="text-gray-500">{instanceCount} 个实例</span>
        </div>
      </div>
      {def.defaultBaseUrl && (
        <div className="text-xs text-gray-500 mt-1 truncate">{def.defaultBaseUrl}</div>
      )}
    </button>
  );
}
