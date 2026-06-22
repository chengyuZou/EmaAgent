import { useState, type CSSProperties } from 'react';
import { Button, Card, Checkbox, Input } from '@ema-agent/ui';
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

export function AskChoicePrompt({
  question, humanDescription, options, multiSelect, allowCustom, onResolve, onCancel,
}: AskChoicePromptProps): JSX.Element {
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
    <Card variant="elevated" padding="lg" className="shadow-2xl max-w-lg w-full">
      <HumanDescriptionPanel description={humanDescription ?? question} toolName="" pending={false} />
      <p className="text-neutral-300 mt-2 text-sm">{question}</p>

      <div className="flex flex-col gap-2 mt-3">
        {options.map((opt, i) =>
          multiSelect ? (
            <label
              key={opt.label}
              className={`flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer border transition-colors ema-stagger-in ${
                selected.has(opt.label)
                  ? 'border-primary-400/40 bg-primary-500/10'
                  : 'border-neutral-700/60 bg-neutral-800/50 hover:bg-neutral-700/40'
              }`}
              style={{ '--stagger-i': i } as CSSProperties}
            >
              <Checkbox
                checked={selected.has(opt.label)}
                onCheckedChange={() => toggle(opt.label)}
                className="mt-0.5 shrink-0"
              />
              <div>
                <div className="text-sm text-neutral-200">{opt.label}</div>
                {opt.humanDescription && (
                  <div className="text-xs text-neutral-500 mt-0.5">{opt.humanDescription}</div>
                )}
              </div>
            </label>
          ) : (
            <button
              key={opt.label}
              className={`text-left px-3 py-2.5 rounded-lg border transition-colors ema-stagger-in ${
                selected.has(opt.label)
                  ? 'border-primary-400/40 bg-primary-500/10 text-primary-100'
                  : 'border-neutral-700/60 bg-neutral-800/50 text-neutral-200 hover:bg-neutral-700/40'
              }`}
              style={{ '--stagger-i': i } as CSSProperties}
              onClick={() => toggle(opt.label)}
            >
              <div className="text-sm font-medium">{opt.label}</div>
              {opt.humanDescription && (
                <div className="text-xs text-neutral-500 mt-0.5">{opt.humanDescription}</div>
              )}
            </button>
          ),
        )}
      </div>

      {allowCustom && (
        <Input
          className="mt-3"
          placeholder="其他（自定义）…"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
        />
      )}

      <div className="flex gap-3 mt-4 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button
          variant="primary"
          size="sm"
          disabled={selected.size === 0 && !customText}
          onClick={() => onResolve([...selected], customText || undefined)}
        >确定</Button>
      </div>
    </Card>
  );
}
