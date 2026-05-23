/** AskChoicePrompt — single/multi select with optional custom input. */
import { useState } from 'react';
import { HumanDescriptionPanel } from './HumanDescriptionPanel.js';

export interface AskChoicePromptProps {
  promptId:          string;
  question:          string;
  humanDescription?: string;
  options:           Array<{ label: string; humanDescription?: string }>;
  multiSelect:       boolean;
  allowCustom?:      boolean;
  onResolve(answers: string[], customText?: string): void;
  onCancel(): void;
}

export function AskChoicePrompt({ question, humanDescription, options, multiSelect, allowCustom, onResolve, onCancel }: AskChoicePromptProps): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customText, setCustomText] = useState('');

  function toggle(label: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (multiSelect) {
        next.has(label) ? next.delete(label) : next.add(label);
      } else {
        next.clear();
        next.add(label);
      }
      return next;
    });
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-2xl">
      <HumanDescriptionPanel description={humanDescription ?? question} toolName="" pending={false} />
      <p className="text-gray-300 mt-2">{question}</p>

      <div className="flex flex-col gap-2 mt-3">
        {options.map((opt) => (
          <button
            key={opt.label}
            className={`px-4 py-2 rounded-xl text-left transition-colors ${
              selected.has(opt.label)
                ? 'bg-pink-400/20 text-pink-300 border border-pink-400/40'
                : 'bg-gray-800 text-gray-300 border border-gray-600 hover:bg-gray-700'
            }`}
            onClick={() => toggle(opt.label)}
          >
            <div className="font-medium">{opt.label}</div>
            {opt.humanDescription && (
              <div className="text-xs text-gray-500 mt-0.5">{opt.humanDescription}</div>
            )}
          </button>
        ))}
      </div>

      {allowCustom && (
        <input
          className="w-full mt-3 bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
          placeholder="其他（自定义）…"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
        />
      )}

      <div className="flex gap-3 mt-4 justify-end">
        <button
          className="px-4 py-2 rounded-xl bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
          onClick={onCancel}
        >取消</button>
        <button
          className="px-4 py-2 rounded-xl bg-pink-400/20 text-pink-300 hover:bg-pink-400/30 transition-colors"
          onClick={() => onResolve([...selected], customText || undefined)}
          disabled={selected.size === 0 && !customText}
        >确定</button>
      </div>
    </div>
  );
}
